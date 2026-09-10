import { and, desc, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { jobs, splats } from "@/lib/server/db/schema";
import { ecrRegistry, launchJob, launchJobLocal, localLaunchEnabled, workerImageUri } from "@/lib/server/ec2Launcher";
import { getEnv } from "@/lib/server/env";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { checkAndIncrementGlobalDaily } from "@/lib/server/rateLimit";
import { jobColumns } from "@/lib/server/selects";

/**
 * The "proceed to train" trigger — launches the second EC2 spot instance for a job whose reconstruct phase already
 * self-terminated at "awaiting_training", reusing that job's own id/callbackToken rather than creating a new job row
 * (see worker/run_job.py's stage split).
 */
export const POST = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/train">) => {
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
        launchJobLocal({ jobId: flipped.id, splatId, callbackToken: flipped.callbackToken, stage: "train" });
        instanceId = null;
      } else {
        instanceId = await launchJob({
          jobId: flipped.id,
          splatId,
          callbackToken: flipped.callbackToken,
          stage: "train",
          workerImageUri: workerImageUri(),
          ecrRegistry: ecrRegistry(),
        });
      }
    } catch (err) {
      // Reverted rather than left at "launching": the reconstruct phase's own output (sparse model, point cloud) is
      // untouched, so the user should be able to just hit "Proceed to train" again instead of being stuck forever —
      // "launching" isn't a status this route (or POST /process's in-flight guard) will ever move on from by itself.
      await getDb().update(jobs).set({ status: "awaiting_training" }).where(eq(jobs.id, flipped.id));
      throw err;
    }

    const [job] = await getDb()
      .update(jobs)
      .set({ ec2InstanceId: instanceId })
      .where(eq(jobs.id, flipped.id))
      .returning(jobColumns);
    return NextResponse.json(job);
  },
);
