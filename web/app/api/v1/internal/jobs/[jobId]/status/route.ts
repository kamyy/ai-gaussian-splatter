import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getJobForCallbackToken } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { jobs, splats } from "@/lib/server/db/schema";
import { HttpError, withErrorHandling } from "@/lib/server/httpError";
import {
  JOB_ENDED_STATUSES,
  JOB_STATUS_DB_VALUES,
  JobStatus,
  LEGACY_COLMAP_RUNNING_STATUS,
  type SplatStatus,
} from "@/lib/types";

/**
 * The worker -> app status callback.
 *
 * The one endpoint whose *field names* are snake_case: worker/pipeline/status.py PATCHes a literal snake_case body.
 * Most status values need no translation: they are the Postgres enum labels verbatim, so `JOB_STATUS_DB_VALUES`
 * validates the incoming value and it goes straight to the column. `LEGACY_COLMAP_RUNNING_STATUS` is the one
 * exception — see its normalization below. Changing either the field names or the status list means changing
 * worker/ in lockstep.
 *
 * Auth is the per-job bearer token, not a Clerk session.
 */
const workerStatusSchema = z.object({
  status: z.enum(JOB_STATUS_DB_VALUES),
  error_message: z.string().nullish(),
  result_s3_key: z.string().nullish(),
  thumbnail_s3_key: z.string().nullish(),
  point_cloud_s3_key: z.string().nullish(),
  ec2_instance_id: z.string().nullish(),
});

export const PATCH = withErrorHandling(
  async (request: NextRequest, ctx: RouteContext<"/api/v1/internal/jobs/[jobId]/status">) => {
    const { jobId } = await ctx.params;
    const job = await getJobForCallbackToken(jobId, request);

    // An ended job is final. web/app/api/v1/splats/[splatId]/process/route.ts cancels a job whose worker stopped
    // reporting so the splat can be processed again, and that worker may still wake up afterwards. Writing a
    // non-terminal status back would give the splat a second active job and trip uq_jobs_splat_id_active
    // (web/lib/server/db/schema.ts). 204 rather than an error because there is nothing for the worker to retry:
    // worker/pipeline/status.py only logs a failed callback anyway.
    //
    // job.status's column type also includes the legacy LEGACY_COLMAP_RUNNING_STATUS (JOB_STATUS_DB_VALUES); it's
    // never actually one of these three ended statuses, so treating it as JobStatus for this membership check is
    // safe without normalizing it first.
    if (JOB_ENDED_STATUSES.includes(job.status as JobStatus)) {
      return new NextResponse(null, { status: 204 });
    }

    const parsed = workerStatusSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(422, "Invalid request body");
    }
    const body = parsed.data;
    // A worker built before "colmap_running" was renamed to "reconstruction_running" can still be running against
    // this database (a worker instance runs for up to WORKER_MAX_LIFETIME_MINUTES, which can outlast a deploy).
    // Normalized here so nothing past this point needs to know the old name ever existed.
    const status: JobStatus =
      body.status === LEGACY_COLMAP_RUNNING_STATUS ? JobStatus.reconstruction_running : body.status;

    const jobData: Partial<typeof jobs.$inferInsert> = { status };
    if (body.error_message != null) {
      jobData.errorMessage = body.error_message;
    }
    if (body.result_s3_key != null) {
      jobData.resultS3Key = body.result_s3_key;
    }
    if (body.thumbnail_s3_key != null) {
      jobData.thumbnailS3Key = body.thumbnail_s3_key;
    }
    if (body.point_cloud_s3_key != null) {
      jobData.pointCloudS3Key = body.point_cloud_s3_key;
    }
    if (body.ec2_instance_id != null) {
      jobData.ec2InstanceId = body.ec2_instance_id;
    }

    // Stage timestamps are only ever set once. A retried or duplicated callback must not overwrite the original start
    // time.
    //
    // colmapFinishedAt is stamped on "awaiting_training", not "training_running": the reconstruct phase's instance
    // self-terminates at "awaiting_training" and the user then decides whether to train, a gap that can last hours.
    // Stamping it on "training_running" instead would fold that think-time into COLMAP's own wall clock.
    //
    // "training_running" stamps colmapFinishedAt too, for a job that arrives here without its "awaiting_training"
    // callback: worker/pipeline/status.py swallows a failed PATCH, so that callback can simply go missing. Without
    // the fallback, colmapFinishedAt would stay null for the life of the job.
    const now = new Date();
    if (status === JobStatus.reconstruction_running && job.colmapStartedAt === null) {
      jobData.colmapStartedAt = now;
    } else if (status === JobStatus.awaiting_training) {
      jobData.colmapFinishedAt = job.colmapFinishedAt ?? now;
    } else if (status === JobStatus.training_running) {
      jobData.colmapFinishedAt = job.colmapFinishedAt ?? now;
      jobData.trainingStartedAt = job.trainingStartedAt ?? now;
    } else if (status === JobStatus.uploading_result) {
      jobData.trainingFinishedAt = job.trainingFinishedAt ?? now;
    }

    const splatData: Partial<typeof splats.$inferInsert> = {};
    let splatStatus: SplatStatus | null = null;
    if (status === JobStatus.complete) {
      splatStatus = "complete";
      if (body.thumbnail_s3_key != null) {
        splatData.thumbnailS3Key = body.thumbnail_s3_key;
      }
    } else if (status === JobStatus.failed) {
      splatStatus = "failed";
    }
    if (splatStatus !== null) {
      splatData.status = splatStatus;
    }

    // Both rows move together or not at all.
    await getDb().transaction(async tx => {
      await tx.update(jobs).set(jobData).where(eq(jobs.id, job.id));
      if (Object.keys(splatData).length > 0) {
        await tx.update(splats).set(splatData).where(eq(splats.id, job.splatId));
      }
    });

    return new NextResponse(null, { status: 204 });
  },
);
