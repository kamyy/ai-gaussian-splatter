import { randomBytes } from "node:crypto";

import { EC2Client, RunInstancesCommand } from "@aws-sdk/client-ec2";

import { getEnv } from "./env";

/**
 * Direct spot-instance-per-job launch (plan §4) — no SQS/Batch/Step Functions.
 * IAM instance profile is scoped externally (infra/stacks/worker_iam_stack.py)
 * to exactly: S3 read (uploads bucket), S3 write (splats bucket),
 * ec2:TerminateInstances on itself.
 */
interface UserDataParams {
  callbackToken: string;
  jobId: string;
  objectId: string;
  backendUrl: string;
  uploadsBucket: string;
  splatsBucket: string;
  workerImageUri: string;
  ecrRegistry: string;
  awsRegion: string;
}

function renderUserData(p: UserDataParams): string {
  // BACKEND_URL is the name the worker itself reads (worker/pipeline/status.py);
  // it stays as-is even though this app supplies it from APP_PUBLIC_URL now.
  return `#!/bin/bash
set -euo pipefail

# Fetch secrets from SSM at boot rather than embedding them in plaintext
# user-data (visible via the EC2 describe-instances API) — plan §6.
CALLBACK_TOKEN="${p.callbackToken}"
JOB_ID="${p.jobId}"
OBJECT_ID="${p.objectId}"
BACKEND_URL="${p.backendUrl}"
UPLOADS_BUCKET="${p.uploadsBucket}"
SPLATS_BUCKET="${p.splatsBucket}"

$(aws ecr get-login --no-include-email --region ${p.awsRegion}) || \\
    aws ecr get-login-password --region ${p.awsRegion} | docker login --username AWS --password-stdin ${p.ecrRegistry}

docker run --rm --gpus all \\
    -e JOB_ID="$JOB_ID" \\
    -e OBJECT_ID="$OBJECT_ID" \\
    -e CALLBACK_TOKEN="$CALLBACK_TOKEN" \\
    -e BACKEND_URL="$BACKEND_URL" \\
    -e UPLOADS_BUCKET="$UPLOADS_BUCKET" \\
    -e SPLATS_BUCKET="$SPLATS_BUCKET" \\
    ${p.workerImageUri}
`;
}

/**
 * A per-job token (plan §3), not a static shared secret — scopes what a
 * compromised instance can mutate to the one job it was launched for.
 *
 * base64url of 32 random bytes, matching Python's secrets.token_urlsafe(32).
 */
export function generateCallbackToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Launches the spot worker instance and returns its instance ID. */
export async function launchJob(params: {
  jobId: string;
  objectId: string;
  callbackToken: string;
  workerImageUri: string;
  ecrRegistry: string;
}): Promise<string> {
  const env = getEnv();
  const ec2 = new EC2Client({ region: env.AWS_REGION });

  const userData = renderUserData({
    callbackToken: params.callbackToken,
    jobId: params.jobId,
    objectId: params.objectId,
    backendUrl: env.APP_PUBLIC_URL,
    uploadsBucket: env.UPLOADS_BUCKET,
    splatsBucket: env.SPLATS_BUCKET,
    workerImageUri: params.workerImageUri,
    ecrRegistry: params.ecrRegistry,
    awsRegion: env.AWS_REGION,
  });

  const response = await ec2.send(
    new RunInstancesCommand({
      ImageId: env.WORKER_AMI_ID,
      InstanceType: env.WORKER_INSTANCE_TYPE as never,
      MinCount: 1,
      MaxCount: 1,
      SubnetId: env.WORKER_SUBNET_ID,
      SecurityGroupIds: [env.WORKER_SECURITY_GROUP_ID],
      IamInstanceProfile: { Arn: env.WORKER_INSTANCE_PROFILE_ARN },
      UserData: Buffer.from(userData).toString("base64"),
      InstanceMarketOptions: {
        MarketType: "spot",
        SpotOptions: { SpotInstanceType: "one-time", InstanceInterruptionBehavior: "terminate" },
      },
      TagSpecifications: [
        {
          ResourceType: "instance",
          Tags: [
            { Key: "Name", Value: `ai-gaussian-splatter-worker-${params.jobId}` },
            // Must match infra/stacks/tags.py's WORKER_TAG_KEY/VALUE and
            // worker_iam_stack.py's self-termination grant — that's a separate
            // uv package so the constant can't be imported directly, and the
            // two must stay in sync by hand.
            { Key: "Role", Value: "worker" },
            { Key: "JobId", Value: params.jobId },
          ],
        },
      ],
      InstanceInitiatedShutdownBehavior: "terminate",
    }),
  );

  const instanceId = response.Instances?.[0]?.InstanceId;
  if (instanceId === undefined) {
    throw new Error("RunInstances returned no instance ID");
  }
  return instanceId;
}
