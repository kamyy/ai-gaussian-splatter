import type { JobStatus, Prisma, SplatStatus } from "@prisma/client";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getJobForCallbackToken } from "@/lib/server/auth";
import { HttpError, withErrorHandling } from "@/lib/server/httpError";
import { getPrisma } from "@/lib/server/prisma";

/**
 * The worker -> app status callback (plan §3).
 *
 * The one endpoint whose wire format is snake_case: worker/pipeline/status.py
 * PATCHes a literal snake_case body with snake_case status values. The field
 * names and status strings below are that contract — changing either means
 * changing worker/ in lockstep.
 *
 * Auth is the per-job bearer token, not a Clerk session.
 */
const WORKER_STATUS_TO_ENUM: Record<string, JobStatus> = {
  queued: "Queued",
  launching: "Launching",
  colmap_running: "ColmapRunning",
  training_running: "TrainingRunning",
  uploading_result: "UploadingResult",
  complete: "Complete",
  failed: "Failed",
  cancelled: "Cancelled",
};

const workerStatusSchema = z.object({
  status: z.enum(Object.keys(WORKER_STATUS_TO_ENUM) as [string, ...string[]]),
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
    const status = WORKER_STATUS_TO_ENUM[body.status];

    const jobData: Prisma.JobUpdateInput = { status };
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
    if (status === "ColmapRunning" && job.colmapStartedAt === null) {
      jobData.colmapStartedAt = now;
    } else if (status === "TrainingRunning") {
      jobData.colmapFinishedAt = job.colmapFinishedAt ?? now;
      jobData.trainingStartedAt = job.trainingStartedAt ?? now;
    } else if (status === "UploadingResult") {
      jobData.trainingFinishedAt = job.trainingFinishedAt ?? now;
    }

    const splatData: Prisma.SplatUpdateInput = {};
    let splatStatus: SplatStatus | null = null;
    if (status === "Complete") {
      splatStatus = "Complete";
      if (body.thumbnail_s3_key != null) {
        splatData.thumbnailS3Key = body.thumbnail_s3_key;
      }
    } else if (status === "Failed") {
      splatStatus = "Failed";
    }
    if (splatStatus !== null) {
      splatData.status = splatStatus;
    }

    // Both rows move together or not at all.
    const prisma = getPrisma();
    await prisma.$transaction([
      prisma.job.update({ where: { id: job.id }, data: jobData }),
      ...(Object.keys(splatData).length > 0
        ? [prisma.splat.update({ where: { id: job.splatId }, data: splatData })]
        : []),
    ]);

    return new NextResponse(null, { status: 204 });
  },
);
