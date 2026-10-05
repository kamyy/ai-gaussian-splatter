/**
 * PATCH /api/v1/internal/jobs/[jobId]/status: the worker's progress callback.
 *
 * The GPU worker (worker/) calls this as it moves a worker job through its stages, and once more when it finishes or
 * fails. Each call updates the worker job's row, and the matching splat's row when the worker job completes or fails.
 * The caller is a machine, not a signed-in person, so auth is the per-worker-job bearer token the app handed the
 * worker at launch rather than a Clerk session.
 *
 * The field names on this route are snake_case, because worker/pipeline/status.py sends a literal snake_case body.
 * web/app/api/v1/internal/jobs/[jobId]/s3-credentials/route.ts uses snake_case field names too. Status values need no
 * translation. They are the Postgres enum labels as-is, so JobStatus validates the incoming value and it goes straight
 * into the column. Changing either the field names or the status list means changing worker/ at the same time.
 */

import { and, eq, notInArray } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getJobForCallbackToken } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { jobs, splats } from "@/lib/server/db/schema";
import { HttpError, parseJsonBody, withErrorHandling } from "@/lib/server/httpError";
import { JOB_ENDED_STATUSES, JobStatus, SplatStatus } from "@/lib/statuses";

const workerStatusSchema = z.object({
  status: z.enum(JobStatus),
  error_message: z.string().nullish(),
  result_ply_s3_key: z.string().nullish(),
  result_spz_s3_key: z.string().nullish(),
  thumbnail_s3_key: z.string().nullish(),
  point_cloud_s3_key: z.string().nullish(),
  training_progress: z.number().int().min(0).max(100).nullish(),
  // Epoch milliseconds, sent with each stage's first callback. Absent on a local run.
  booted_at: z.number().int().positive().nullish(),
});

/**
 * Throws 400 unless every key sits under this splat's own prefix. The app presigns these keys for the splat's owner and
 * for anyone holding its share link (web/lib/server/data.ts). A worker instance compromised by a crafted photo could
 * otherwise point its own splat at another user's files and publish them through that share link. A ".." segment is
 * refused too, because a browser collapses it before the request reaches S3.
 */
function requireOwnKeys(splatId: string, keys: (string | null | undefined)[]): void {
  const prefix = `splats/${splatId}/`;
  for (const key of keys) {
    if (key != null && (!key.startsWith(prefix) || key.split("/").includes(".."))) {
      throw new HttpError(400, "An S3 key is outside this splat's own prefix");
    }
  }
}

export const PATCH = withErrorHandling(
  async (request: NextRequest, ctx: RouteContext<"/api/v1/internal/jobs/[jobId]/status">) => {
    const { jobId } = await ctx.params;
    const job = await getJobForCallbackToken(jobId, request);

    // An ended job is final. web/app/api/v1/splats/[splatId]/process/route.ts cancels a job whose worker stopped
    // reporting so the splat can be processed again, and that worker may still wake up afterwards. Writing a
    // non-terminal status back would give the splat a second active job and trip uq_jobs_splat_id_active
    // (web/lib/server/db/schema.ts). 204 rather than an error because there is nothing for the worker to retry:
    // worker/pipeline/status.py only logs a failed callback anyway.
    if (JOB_ENDED_STATUSES.includes(job.status)) {
      return new NextResponse(null, { status: 204 });
    }

    const body = await parseJsonBody(request, workerStatusSchema);
    const { status } = body;
    requireOwnKeys(job.splatId, [
      body.result_ply_s3_key,
      body.result_spz_s3_key,
      body.thumbnail_s3_key,
      body.point_cloud_s3_key,
    ]);

    const jobData: Partial<typeof jobs.$inferInsert> = { status };
    if (body.error_message != null) {
      jobData.errorMessage = body.error_message;
    }

    if (body.result_ply_s3_key != null) {
      jobData.resultPlyS3Key = body.result_ply_s3_key;
    }

    if (body.result_spz_s3_key != null) {
      jobData.resultSpzS3Key = body.result_spz_s3_key;
    }

    if (body.thumbnail_s3_key != null) {
      jobData.thumbnailS3Key = body.thumbnail_s3_key;
    }

    if (body.point_cloud_s3_key != null) {
      jobData.pointCloudS3Key = body.point_cloud_s3_key;
    }

    if (body.training_progress != null) {
      jobData.trainingProgress = body.training_progress;
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
    const bootedAt = body.booted_at == null ? null : new Date(body.booted_at);
    if (status === JobStatus.reconstruction_running && job.colmapStartedAt === null) {
      jobData.colmapStartedAt = now;
      jobData.colmapBootedAt = job.colmapBootedAt ?? bootedAt;
    } else if (status === JobStatus.awaiting_training) {
      jobData.colmapFinishedAt = job.colmapFinishedAt ?? now;
    } else if (status === JobStatus.training_running) {
      jobData.colmapFinishedAt = job.colmapFinishedAt ?? now;
      jobData.trainingStartedAt = job.trainingStartedAt ?? now;
      jobData.trainingBootedAt = job.trainingBootedAt ?? bootedAt;
    } else if (status === JobStatus.uploading_result) {
      jobData.trainingFinishedAt = job.trainingFinishedAt ?? now;
    } else if (status === JobStatus.complete) {
      jobData.completedAt = job.completedAt ?? now;
    }

    const splatData: Partial<typeof splats.$inferInsert> = {};
    if (status === JobStatus.complete) {
      splatData.status = SplatStatus.complete;
      if (body.thumbnail_s3_key != null) {
        splatData.thumbnailS3Key = body.thumbnail_s3_key;
      }
    } else if (status === JobStatus.failed) {
      splatData.status = SplatStatus.failed;
    }

    // Both rows move together or not at all. The job write is conditional on it still not having ended, so a cancel
    // (web/lib/server/cancelJob.ts) landing between the read above and this write isn't overwritten.
    await getDb().transaction(async tx => {
      const updated = await tx
        .update(jobs)
        .set(jobData)
        .where(and(eq(jobs.id, job.id), notInArray(jobs.status, JOB_ENDED_STATUSES)))
        .returning({ id: jobs.id });
      if (updated.length > 0 && Object.keys(splatData).length > 0) {
        await tx.update(splats).set(splatData).where(eq(splats.id, job.splatId));
      }
    });

    return new NextResponse(null, { status: 204 });
  },
);
