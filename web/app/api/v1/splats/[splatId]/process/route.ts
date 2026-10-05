/**
 * POST /api/v1/splats/[splatId]/process: start processing a splat.
 *
 * Creates a worker job and launches its first GPU spot instance, which runs the reconstruct stage (COLMAP, the
 * structure-from-motion step that works out where each photo was taken). At most one active worker job per splat is
 * enforced here. The site-wide daily cap on worker jobs is charged here.
 * web/app/api/v1/splats/[splatId]/train/route.ts charges that same cap when the train stage launches.
 */

import { and, count, eq, lt, notInArray } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { MAX_PHOTOS_PER_SPLAT } from "@/lib/limits";
import { requireOwnedSplat, requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { jobs, photos, splats } from "@/lib/server/db/schema";
import { HttpError, withErrorHandling } from "@/lib/server/httpError";
import { checkAndIncrementGlobalDaily } from "@/lib/server/rateLimit";
import { requireProcessingEnabled } from "@/lib/server/runtimeSettings";
import { jobColumns } from "@/lib/server/selects";
import { launchWorker, stopWorker } from "@/lib/server/worker";
import { generateCallbackToken } from "@/lib/server/workerLauncher";
import { JOB_ENDED_STATUSES, JobStatus, PhotoUploadStatus, SplatStatus } from "@/lib/statuses";

// How long a non-ended worker job on this splat may go without a row change before this route cancels it.
// awaiting_training is included, so a visitor who waits out the window loses that worker job. Training reports
// progress about 20 times a run. The long silent stretch of a running stage is reconstruct, from reconstruction_running
// until awaiting_training.
const JOB_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

// Postgres error code 23505 (unique violation). drizzle-orm wraps the raw node-postgres DatabaseError, which carries
// `.code` itself, in its own error that adds the failed query for debugging. The driver error ends up on `.cause`
// rather than `.code`, so both layers need checking.
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }

  if ("code" in err && err.code === "23505") {
    return true;
  }

  return "cause" in err && isUniqueViolation(err.cause);
}

export const POST = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/process">) => {
    const user = await requireUser();
    const { splatId } = await ctx.params;
    await requireOwnedSplat(splatId, user.id);

    // Checked before anything else about the splat, so a paused site says so rather than naming some other problem.
    const settings = await requireProcessingEnabled();

    const [uploaded] = await getDb()
      .select({ n: count() })
      .from(photos)
      .where(and(eq(photos.splatId, splatId), eq(photos.uploadStatus, PhotoUploadStatus.uploaded)));
    if (uploaded.n < settings.minPhotosPerSplat) {
      throw new HttpError(400, `Need at least ${settings.minPhotosPerSplat} uploaded photos, have ${uploaded.n}`);
    }

    // The presign route enforces this too, but two concurrent presign batches can each pass it. This is the check that
    // stands between an oversized photo set and a GPU instance.
    if (uploaded.n > MAX_PHOTOS_PER_SPLAT) {
      throw new HttpError(400, `A splat can have at most ${MAX_PHOTOS_PER_SPLAT} photos, has ${uploaded.n}`);
    }

    // `uq_jobs_splat_id_active` (web/lib/server/db/schema.ts) makes an active worker job block every later POST here.
    // web/lib/server/reconcileJob.ts fails a worker job whose worker instance died. That check runs while the splat's
    // page polls. A local launch stays unchanged. A worker job with no instance id stays unchanged. Any other dead
    // worker instance would leave its splat unprocessable, so a worker job whose row has not changed in
    // JOB_STALE_AFTER_MS is cancelled here to free the index. The status callback ignores a worker job that has already
    // ended (web/app/api/v1/internal/jobs/[jobId]/status/route.ts). A worker that wakes up late can't bring the
    // cancelled row back.
    await getDb()
      .update(jobs)
      .set({
        status: JobStatus.cancelled,
        errorMessage: "Worker stopped reporting; cancelled so processing could restart.",
      })
      .where(
        and(
          eq(jobs.splatId, splatId),
          notInArray(jobs.status, JOB_ENDED_STATUSES),
          lt(jobs.updatedAt, new Date(Date.now() - JOB_STALE_AFTER_MS)),
        ),
      );

    // A worker job sits at "awaiting_training" while the visitor decides. This route cancels it once the row has gone
    // JOB_STALE_AFTER_MS without a change. A second POST is easy to reach before then. The unique index above
    // enforces at most one active worker job per splat. A race loses here as a unique violation. A separate
    // read-then-write check could itself race.
    //
    // The row is claimed before the daily cap is charged. A rejected duplicate must not consume one of the day's
    // max-jobs-per-day units, or a user clicking a dead button could exhaust the site-wide GPU budget without
    // ever launching an instance.
    const callbackToken = generateCallbackToken();
    let created: { id: string };
    try {
      [created] = await getDb().insert(jobs).values({ splatId, status: JobStatus.queued, callbackToken }).returning({
        id: jobs.id,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new HttpError(409, "A job is already in progress for this splat");
      }

      throw err;
    }

    // The hard backstop on total GPU spend. The per-IP and per-user limits sit earlier in the flow, on the presign
    // route (web/app/api/v1/splats/[splatId]/photos/presign/route.ts), so most abuse is screened before a splat has
    // enough photos to reach this route at all. The claimed row is deleted rather than marked failed when the cap
    // rejects: nothing has run for it, and leaving a failed job behind would make the next attempt report a failure
    // that never happened.
    try {
      await checkAndIncrementGlobalDaily(settings.maxJobsPerDay);
    } catch (err) {
      await getDb().delete(jobs).where(eq(jobs.id, created.id));
      throw err;
    }

    await getDb().update(splats).set({ status: SplatStatus.processing }).where(eq(splats.id, splatId));

    let instanceId: string | null;
    try {
      instanceId = await launchWorker({ jobId: created.id, splatId, callbackToken, stage: "reconstruct", settings });
    } catch (err) {
      // Marked failed rather than left at "queued": "queued" is active under uq_jobs_splat_id_active, so a stuck job
      // there would block every future POST /process for this splat with no way to clear it. Conditional on the job
      // still being "queued", so a cancel that landed during the launch stays cancelled and doesn't fail the splat.
      const message = err instanceof Error ? err.message : "Failed to launch worker instance";
      await getDb().transaction(async tx => {
        const [failed] = await tx
          .update(jobs)
          .set({ status: JobStatus.failed, errorMessage: message })
          .where(and(eq(jobs.id, created.id), eq(jobs.status, JobStatus.queued)))
          .returning({ id: jobs.id });
        if (failed !== undefined) {
          await tx.update(splats).set({ status: SplatStatus.failed }).where(eq(splats.id, splatId));
        }
      });
      throw err;
    }

    // Conditional on the job still being "queued": a cancel (web/lib/server/cancelJob.ts) can land while the launch
    // above is in flight, before there is an instance ID for it to terminate. That worker is stopped here instead.
    const [job] = await getDb()
      .update(jobs)
      .set({ status: JobStatus.launching, ec2InstanceId: instanceId })
      .where(and(eq(jobs.id, created.id), eq(jobs.status, JobStatus.queued)))
      .returning(jobColumns);
    if (job === undefined) {
      await stopWorker(created.id, instanceId);
      throw new HttpError(409, "Cancelled before the worker started");
    }

    return NextResponse.json(job, { status: 201 });
  },
);
