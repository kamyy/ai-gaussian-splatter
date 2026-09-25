import { and, count, eq, lt, notInArray } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { jobs, photos, splats } from "@/lib/server/db/schema";
import {
  ecrRegistry,
  generateCallbackToken,
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

// How long a job may sit in a non-terminal status without its worker reporting anything before this route treats it
// as dead and cancels it. The window has to clear the longest gap a healthy job can go between callbacks, which is a
// whole training run, so it is deliberately generous.
const JOB_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export const POST = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/process">) => {
    const env = getEnv();
    const user = await requireUser();
    const { splatId } = await ctx.params;
    requireUuid(splatId, 404, "Splat not found");

    const [splat] = await getDb()
      .select()
      .from(splats)
      .where(and(eq(splats.id, splatId), eq(splats.userId, user.id)))
      .limit(1);
    if (splat === undefined) {
      throw new HttpError(404, "Splat not found");
    }

    const [uploaded] = await getDb()
      .select({ n: count() })
      .from(photos)
      .where(and(eq(photos.splatId, splatId), eq(photos.uploadStatus, "uploaded")));
    if (uploaded.n < env.MIN_PHOTOS_PER_SPLAT) {
      throw new HttpError(400, `Need at least ${env.MIN_PHOTOS_PER_SPLAT} uploaded photos, have ${uploaded.n}`);
    }

    // `uq_jobs_splat_id_active` (web/lib/server/db/schema.ts) makes an active job block every later POST here. Nothing
    // outside the worker itself ever moves a job on from "launching" or "reconstruction_running". A worker that dies
    // before it reports would therefore leave its splat unprocessable for good, so a job whose status hasn't moved in
    // JOB_STALE_AFTER_MS is cancelled here to free the index. The status callback ignores a job that has already ended
    // (web/app/api/v1/internal/jobs/[jobId]/status/route.ts), so a worker that wakes up late can't bring the cancelled
    // row back.
    await getDb()
      .update(jobs)
      .set({ status: "cancelled", errorMessage: "Worker stopped reporting; cancelled so processing could restart." })
      .where(
        and(
          eq(jobs.splatId, splatId),
          notInArray(jobs.status, JOB_ENDED_STATUSES),
          lt(jobs.updatedAt, new Date(Date.now() - JOB_STALE_AFTER_MS)),
        ),
      );

    // A job can sit at "awaiting_training" for as long as the user takes to decide, so a second POST arriving while
    // one is in flight is easy to reach by accident. The unique index above enforces "at most one active job per
    // splat" at the database level, so a race loses here as a unique violation rather than needing a separate
    // read-then-write check that could itself race.
    //
    // The row is claimed before the daily cap is charged. A rejected duplicate must not consume one of the day's
    // GLOBAL_MAX_JOBS_PER_DAY units, or a user clicking a dead button could exhaust the site-wide GPU budget without
    // ever launching an instance.
    const callbackToken = generateCallbackToken();
    let created: { id: string };
    try {
      [created] = await getDb().insert(jobs).values({ splatId, status: "queued", callbackToken }).returning({
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
      await checkAndIncrementGlobalDaily(env.GLOBAL_MAX_JOBS_PER_DAY);
    } catch (err) {
      await getDb().delete(jobs).where(eq(jobs.id, created.id));
      throw err;
    }

    await getDb().update(splats).set({ status: "processing" }).where(eq(splats.id, splatId));

    let instanceId: string | null;
    try {
      if (localLaunchEnabled()) {
        launchJobLocal({ jobId: created.id, splatId, callbackToken, stage: "reconstruct" });
        instanceId = null;
      } else {
        instanceId = await launchJob({
          jobId: created.id,
          splatId,
          callbackToken,
          stage: "reconstruct",
          workerImageUri: workerImageUri("reconstruct"),
          ecrRegistry: ecrRegistry(),
        });
      }
    } catch (err) {
      // Marked failed rather than left at "queued": "queued" is active under uq_jobs_splat_id_active, so a stuck job
      // there would block every future POST /process for this splat with no way to clear it.
      const message = err instanceof Error ? err.message : "Failed to launch worker instance";
      await getDb().transaction(async tx => {
        await tx.update(jobs).set({ status: "failed", errorMessage: message }).where(eq(jobs.id, created.id));
        await tx.update(splats).set({ status: "failed" }).where(eq(splats.id, splatId));
      });
      throw err;
    }

    // Conditional on the job still being "queued": a cancel (web/lib/server/cancelJob.ts) can land while the launch
    // above is in flight, before there is an instance ID for it to terminate. That worker is stopped here instead.
    const [job] = await getDb()
      .update(jobs)
      .set({ status: "launching", ec2InstanceId: instanceId })
      .where(and(eq(jobs.id, created.id), eq(jobs.status, "queued")))
      .returning(jobColumns);
    if (job === undefined) {
      if (instanceId === null) {
        stopLocalWorker(created.id);
      } else {
        await terminateWorker(instanceId);
      }
      throw new HttpError(409, "Cancelled before the worker started");
    }
    return NextResponse.json(job, { status: 201 });
  },
);
