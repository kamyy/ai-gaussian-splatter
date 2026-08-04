import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getJobForCallbackToken } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { jobs, splats } from "@/lib/server/db/schema";
import { HttpError, withErrorHandling } from "@/lib/server/httpError";
import { JOB_STATUSES, type SplatStatus } from "@/lib/types";

/**
 * The worker -> app status callback (plan §3).
 *
 * The one endpoint whose *field names* are snake_case: worker/pipeline/status.py
 * PATCHes a literal snake_case body. The status values need no translation —
 * they are the Postgres enum labels verbatim, so `JOB_STATUSES` validates the
 * incoming value and it goes straight to the column. Changing either the field
 * names or the status list means changing worker/ in lockstep.
 *
 * Auth is the per-job bearer token, not a Clerk session.
 */
const workerStatusSchema = z.object({
  status: z.enum(JOB_STATUSES),
  error_message: z.string().nullish(),
  result_s3_key: z.string().nullish(),
  thumbnail_s3_key: z.string().nullish(),
  ec2_instance_id: z.string().nullish(),
});

export const PATCH = withErrorHandling(
  async (request: NextRequest, ctx: RouteContext<"/api/v1/internal/jobs/[jobId]/status">) => {
    const { jobId } = await ctx.params;
    const job = await getJobForCallbackToken(jobId, request);

    const parsed = workerStatusSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(422, "Invalid request body");
    }
    const body = parsed.data;
    const status = body.status;

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
    if (body.ec2_instance_id != null) {
      jobData.ec2InstanceId = body.ec2_instance_id;
    }

    // Stage timestamps are only ever set once — a retried or duplicated
    // callback must not overwrite the original start time.
    const now = new Date();
    if (status === "colmap_running" && job.colmapStartedAt === null) {
      jobData.colmapStartedAt = now;
    } else if (status === "training_running") {
      jobData.colmapFinishedAt = job.colmapFinishedAt ?? now;
      jobData.trainingStartedAt = job.trainingStartedAt ?? now;
    } else if (status === "uploading_result") {
      jobData.trainingFinishedAt = job.trainingFinishedAt ?? now;
    }

    const splatData: Partial<typeof splats.$inferInsert> = {};
    let splatStatus: SplatStatus | null = null;
    if (status === "complete") {
      splatStatus = "complete";
      if (body.thumbnail_s3_key != null) {
        splatData.thumbnailS3Key = body.thumbnail_s3_key;
      }
    } else if (status === "failed") {
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
