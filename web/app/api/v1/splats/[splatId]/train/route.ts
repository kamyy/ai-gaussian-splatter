/**
 * POST /api/v1/splats/[splatId]/train: start the training stage.
 *
 * The check stage's build button calls this once the visitor has looked over the point cloud, optionally with a crop
 * box. It launches the second GPU spot instance for a job whose reconstruct stage stopped at "awaiting_training",
 * reusing that job's own id and callback token rather than creating a new job row (see worker/run_job.py's stage
 * split).
 */

import { and, desc, eq, notInArray } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requireOwnedSplat, requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { jobs } from "@/lib/server/db/schema";
import { HttpError, parseJsonBody, withErrorHandling } from "@/lib/server/httpError";
import { checkAndIncrementGlobalDaily } from "@/lib/server/rateLimit";
import { requireProcessingEnabled } from "@/lib/server/runtimeSettings";
import { jobColumns } from "@/lib/server/selects";
import { launchWorker, stopWorker } from "@/lib/server/worker";
import { JOB_ENDED_STATUSES, JobStatus } from "@/lib/statuses";

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

export const POST = withErrorHandling(
  async (request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/train">) => {
    const user = await requireUser();
    const { splatId } = await ctx.params;
    await requireOwnedSplat(splatId, user.id);

    // Parsed before the flip below, so a malformed box never moves the job or charges the daily cap.
    const { cropBox } = await parseJsonBody(request, trainSchema);

    // Checked before the flip below, so a paused site leaves the job waiting at "awaiting_training".
    const settings = await requireProcessingEnabled();

    const [latestJob] = await getDb()
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.splatId, splatId))
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    if (latestJob === undefined) {
      throw new HttpError(409, "No job awaiting training for this splat");
    }

    // A single conditional UPDATE rather than a read followed by a write, so a double-click can't launch two
    // train-stage instances for the same job. Only the request that actually flips awaiting_training to launching gets
    // to launch.
    //
    // The flip happens before the daily cap is charged. A double-click's losing request must not use up one of the
    // day's max-jobs-per-day units, or repeated clicking could exhaust the site-wide GPU budget without ever
    // launching an instance.
    const [flipped] = await getDb()
      .update(jobs)
      .set({ status: JobStatus.launching, trainingLaunchedAt: new Date() })
      .where(and(eq(jobs.id, latestJob.id), eq(jobs.status, JobStatus.awaiting_training)))
      .returning();
    if (flipped === undefined) {
      throw new HttpError(409, "No job awaiting training for this splat");
    }

    // This is a second real GPU spot instance for the same splat, so it counts against the daily cap just like the
    // reconstruct-phase launch did.
    //
    // A rejection by the cap or a failed launch reverts the flip rather than leaving the job at "launching". The
    // reconstruct phase's own output (sparse model, point cloud) is untouched, so the user can just click the check
    // stage's build button again. Left at "launching" the job blocks on POST /process's JOB_STALE_AFTER_MS sweep
    // instead, which is hours away and cancels the job outright. The revert is conditional on the job still being
    // "launching", so a cancel that landed in the meantime stays cancelled.
    let instanceId: string | null;
    try {
      await checkAndIncrementGlobalDaily(settings.maxJobsPerDay);
      instanceId = await launchWorker({
        jobId: flipped.id,
        splatId,
        callbackToken: flipped.callbackToken,
        stage: "train",
        settings,
        cropBox,
      });
    } catch (err) {
      await getDb()
        .update(jobs)
        .set({ status: JobStatus.awaiting_training, trainingLaunchedAt: null })
        .where(and(eq(jobs.id, flipped.id), eq(jobs.status, JobStatus.launching)));
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
      await stopWorker(flipped.id, instanceId);
      throw new HttpError(409, "Cancelled before the worker started");
    }

    return NextResponse.json(job);
  },
);
