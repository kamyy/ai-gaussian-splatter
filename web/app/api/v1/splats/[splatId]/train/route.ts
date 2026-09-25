import { and, desc, eq, notInArray } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { jobs, splats } from "@/lib/server/db/schema";
import {
  ecrRegistry,
  launchJob,
  launchJobLocal,
  localLaunchEnabled,
  stopLocalWorker,
  terminateWorker,
  workerImageUri,
} from "@/lib/server/ec2Launcher";
import { getEnv } from "@/lib/server/env";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { checkAndIncrementGlobalDaily } from "@/lib/server/rateLimit";
import { jobColumns } from "@/lib/server/selects";
import { JOB_ENDED_STATUSES } from "@/lib/types";

// Nothing but numbers survives the parse, which is what lets web/lib/server/ec2Launcher.ts single-quote the box's JSON
// inside the user-data script.
const trainSchema = z.object({
  cropBox: z
    .object({
      center: z.tuple([z.number(), z.number(), z.number()]),
      size: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
      quaternion: z
        .tuple([z.number(), z.number(), z.number(), z.number()])
        .refine(quaternion => Math.hypot(...quaternion) > 1e-6, "A rotation quaternion can't be zero"),
    })
    .optional(),
});

/**
 * The "Start training" trigger — launches the second EC2 spot instance for a job whose reconstruct phase already
 * self-terminated at "awaiting_training", reusing that job's own id/callbackToken rather than creating a new job row
 * (see worker/run_job.py's stage split).
 */
export const POST = withErrorHandling(
  async (request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/train">) => {
    const env = getEnv();
    const user = await requireUser();
    const { splatId } = await ctx.params;
    requireUuid(splatId, 404, "Splat not found");

    const [splat] = await getDb()
      .select({ id: splats.id })
      .from(splats)
      .where(and(eq(splats.id, splatId), eq(splats.userId, user.id)))
      .limit(1);
    if (splat === undefined) {
      throw new HttpError(404, "Splat not found");
    }

    // Parsed before the flip below, so a malformed box never moves the job or charges the daily cap.
    const parsed = trainSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(422, "Invalid request body");
    }
    const { cropBox } = parsed.data;

    const [latestJob] = await getDb()
      .select()
      .from(jobs)
      .where(eq(jobs.splatId, splatId))
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    if (latestJob === undefined) {
      throw new HttpError(409, "No job awaiting training for this splat");
    }

    // A single conditional UPDATE, not a read-then-write, so a double-click can't launch two train-phase instances
    // against the same job — only the request that actually flips awaiting_training -> launching gets to launch.
    //
    // The flip comes before the daily cap is charged. A double-click's losing request must not consume one of the
    // day's GLOBAL_MAX_JOBS_PER_DAY units, or repeated clicking could exhaust the site-wide GPU budget without ever
    // launching an instance.
    const [flipped] = await getDb()
      .update(jobs)
      .set({ status: "launching" })
      .where(and(eq(jobs.id, latestJob.id), eq(jobs.status, "awaiting_training")))
      .returning();
    if (flipped === undefined) {
      throw new HttpError(409, "No job awaiting training for this splat");
    }

    // This is a second real GPU spot instance for the same splat, so it counts against the daily cap just like the
    // reconstruct-phase launch did. The flip is reverted when the cap rejects, so hitting it leaves the job back at
    // "awaiting_training" for the user to retry once the cap resets rather than stranding it at "launching".
    try {
      await checkAndIncrementGlobalDaily(env.GLOBAL_MAX_JOBS_PER_DAY);
    } catch (err) {
      await getDb().update(jobs).set({ status: "awaiting_training" }).where(eq(jobs.id, flipped.id));
      throw err;
    }

    let instanceId: string | null;
    try {
      if (localLaunchEnabled()) {
        launchJobLocal({ jobId: flipped.id, splatId, callbackToken: flipped.callbackToken, stage: "train", cropBox });
        instanceId = null;
      } else {
        instanceId = await launchJob({
          jobId: flipped.id,
          splatId,
          callbackToken: flipped.callbackToken,
          stage: "train",
          workerImageUri: workerImageUri("train"),
          ecrRegistry: ecrRegistry(),
          cropBox,
        });
      }
    } catch (err) {
      // Reverted rather than left at "launching": the reconstruct phase's own output (sparse model, point cloud) is
      // untouched, so the user can just hit "Start training" again. Left at "launching" the job blocks on
      // POST /process's JOB_STALE_AFTER_MS sweep instead, which is hours away and cancels the job outright.
      await getDb().update(jobs).set({ status: "awaiting_training" }).where(eq(jobs.id, flipped.id));
      throw err;
    }

    // Conditional on the job not having ended: a cancel (web/lib/server/cancelJob.ts) can land while the launch above
    // is in flight, before there is an instance ID for it to terminate. That worker is stopped here instead.
    const [job] = await getDb()
      .update(jobs)
      .set({ ec2InstanceId: instanceId })
      .where(and(eq(jobs.id, flipped.id), notInArray(jobs.status, JOB_ENDED_STATUSES)))
      .returning(jobColumns);
    if (job === undefined) {
      if (instanceId === null) {
        stopLocalWorker(flipped.id);
      } else {
        await terminateWorker(instanceId);
      }
      throw new HttpError(409, "Cancelled before the worker started");
    }
    return NextResponse.json(job);
  },
);
