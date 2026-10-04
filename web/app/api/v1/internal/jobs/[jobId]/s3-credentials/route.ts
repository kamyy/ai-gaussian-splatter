/**
 * POST /api/v1/internal/jobs/[jobId]/s3-credentials: S3 credentials for a worker instance, scoped to its own splat.
 *
 * A worker instance's IAM role has no S3 access (infra/worker_iam.tf). The instance runs COLMAP and gsplat on photos
 * anyone can upload, and one taken over by a crafted photo must not reach other users' files. The worker calls this
 * route with its callback token before each batch of downloads or uploads (worker/pipeline/storage.py) instead. The
 * route assumes infra/worker_iam.tf's worker data role with a session policy naming only this splat's keys. The
 * credentials it returns can read the splat's photos and read and write its results, and nothing else.
 *
 * The response's field names are snake_case, like the status callback's, because worker/pipeline/storage.py reads them
 * as they are.
 */

import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { type NextRequest, NextResponse } from "next/server";

import { getJobForCallbackToken } from "@/lib/server/auth";
import { getEnv } from "@/lib/server/env";
import { HttpError, withErrorHandling } from "@/lib/server/httpError";
import { JOB_ENDED_STATUSES, type JobStatus } from "@/lib/statuses";

// An hour is the most AWS allows when one role assumes another. The worker asks again for each batch rather than
// holding one set for a whole stage, so a long training run never outlives its credentials.
const CREDENTIALS_DURATION_SECONDS = 60 * 60;

/**
 * Narrows the worker data role to one splat. Listing is granted on the splat's own prefix only, which is also what
 * lets the worker tell a missing object from a forbidden one. Exported for its tests.
 */
export function splatSessionPolicy(uploadsBucket: string, splatsBucket: string, splatId: string): string {
  const photos = `splats/${splatId}/photos/`;
  const results = `splats/${splatId}/`;

  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: "s3:ListBucket",
        Resource: `arn:aws:s3:::${uploadsBucket}`,
        Condition: { StringLike: { "s3:prefix": `${photos}*` } },
      },
      {
        Effect: "Allow",
        Action: "s3:GetObject",
        Resource: `arn:aws:s3:::${uploadsBucket}/${photos}*`,
      },
      {
        Effect: "Allow",
        Action: "s3:ListBucket",
        Resource: `arn:aws:s3:::${splatsBucket}`,
        Condition: { StringLike: { "s3:prefix": `${results}*` } },
      },
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload"],
        Resource: `arn:aws:s3:::${splatsBucket}/${results}*`,
      },
    ],
  });
}

export const POST = withErrorHandling(
  async (request: NextRequest, ctx: RouteContext<"/api/v1/internal/jobs/[jobId]/s3-credentials">) => {
    const { jobId } = await ctx.params;
    const job = await getJobForCallbackToken(jobId, request);

    // A cancelled or finished job's worker has nothing left to read or write. Refusing it also stops a callback token
    // that outlived its job from unlocking the splat's files.
    if (JOB_ENDED_STATUSES.includes(job.status as JobStatus)) {
      throw new HttpError(409, "This job has ended");
    }

    const env = getEnv();
    const { Credentials: credentials } = await new STSClient({ region: env.AWS_REGION }).send(
      new AssumeRoleCommand({
        RoleArn: env.WORKER_DATA_ROLE_ARN,
        RoleSessionName: `worker-${job.id}`,
        DurationSeconds: CREDENTIALS_DURATION_SECONDS,
        Policy: splatSessionPolicy(env.UPLOADS_BUCKET, env.SPLATS_BUCKET, job.splatId),
      }),
    );
    if (
      credentials?.AccessKeyId === undefined ||
      credentials.SecretAccessKey === undefined ||
      credentials.SessionToken === undefined
    ) {
      throw new Error("AssumeRole returned no credentials");
    }

    return NextResponse.json({
      access_key_id: credentials.AccessKeyId,
      secret_access_key: credentials.SecretAccessKey,
      session_token: credentials.SessionToken,
    });
  },
);
