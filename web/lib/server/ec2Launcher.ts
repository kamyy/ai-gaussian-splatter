import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";

import { EC2Client, RunInstancesCommand } from "@aws-sdk/client-ec2";

import { getEnv } from "./env";

/**
 * Direct spot-instance-per-job launch — no SQS/Batch/Step Functions. IAM instance profile is scoped externally
 * (infra/stacks/worker_iam_stack.py) to exactly: S3 read (uploads bucket), S3 read/write (splats bucket),
 * ec2:TerminateInstances on itself.
 */
interface UserDataParams {
  callbackToken: string;
  jobId: string;
  splatId: string;
  appPublicUrl: string;
  uploadsBucket: string;
  splatsBucket: string;
  workerImageUri: string;
  ecrRegistry: string;
  awsRegion: string;
}

function renderUserData(p: UserDataParams): string {
  return `#!/bin/bash
set -euo pipefail

# Plaintext, and EC2 user-data is readable by anyone holding
# ec2:DescribeInstances. The token is per-job and only authorizes status
# updates on that one job (lib/server/auth.ts), which is what bounds this.
CALLBACK_TOKEN="${p.callbackToken}"
JOB_ID="${p.jobId}"
SPLAT_ID="${p.splatId}"
APP_PUBLIC_URL="${p.appPublicUrl}"
UPLOADS_BUCKET="${p.uploadsBucket}"
SPLATS_BUCKET="${p.splatsBucket}"

$(aws ecr get-login --no-include-email --region ${p.awsRegion}) || \\
    aws ecr get-login-password --region ${p.awsRegion} | docker login --username AWS --password-stdin ${p.ecrRegistry}

docker run --rm --gpus all \\
    -e JOB_ID="$JOB_ID" \\
    -e SPLAT_ID="$SPLAT_ID" \\
    -e CALLBACK_TOKEN="$CALLBACK_TOKEN" \\
    -e APP_PUBLIC_URL="$APP_PUBLIC_URL" \\
    -e UPLOADS_BUCKET="$UPLOADS_BUCKET" \\
    -e SPLATS_BUCKET="$SPLATS_BUCKET" \\
    ${p.workerImageUri}
`;
}

/**
 * A per-job token, not a static shared secret — scopes what a compromised instance can mutate to the one job it was
 * launched for.
 *
 * base64url of 32 random bytes, matching Python's secrets.token_urlsafe(32).
 */
export function generateCallbackToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Launches the spot worker instance and returns its instance ID. */
export async function launchJob(params: {
  jobId: string;
  splatId: string;
  callbackToken: string;
  workerImageUri: string;
  ecrRegistry: string;
}): Promise<string> {
  const env = getEnv();
  const ec2 = new EC2Client({ region: env.AWS_REGION });

  const userData = renderUserData({
    callbackToken: params.callbackToken,
    jobId: params.jobId,
    splatId: params.splatId,
    appPublicUrl: env.APP_PUBLIC_URL,
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
      // The pipeline runs in a container on default bridge networking, which puts IMDS one hop further away than the
      // host. EC2's default response hop limit of 1 therefore drops the token PUT that worker/pipeline/instance.py
      // opens with, so it cannot read its own instance ID and skips self-termination. The instance then bills until
      // someone notices. Raising the limit is the fix. Requiring tokens is only safe alongside it, since it removes the
      // IMDSv1 fallback the container would otherwise be relying on for credentials.
      MetadataOptions: {
        HttpTokens: "required",
        HttpPutResponseHopLimit: 2,
      },
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
            // Must match infra/stacks/tags.py's WORKER_TAG_KEY/VALUE and worker_iam_stack.py's self-termination grant.
            // That's a separate uv package, so the constant can't be imported directly, and the two must stay in sync
            // by hand.
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

/**
 * Local-dev substitute for launchJob(): runs the worker image on the caller's own GPU via Podman instead of
 * launching a real EC2 spot instance. Gated behind WORKER_LOCAL_LAUNCH in process/route.ts and never reachable in
 * production, where the ECS task has neither a podman binary nor a GPU.
 *
 * Fire-and-forget like the EC2 launch it replaces: the worker reports its own progress back over
 * APP_PUBLIC_URL/CALLBACK_TOKEN (worker/pipeline/status.py), so this function doesn't wait on the container.
 */
export function launchJobLocal(params: { jobId: string; splatId: string; callbackToken: string }): void {
  const env = getEnv();
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set to launch the worker locally");
  }

  // repo-root/worker/jobdir/<jobId>, matching the manual run in RUNBOOK.md so a local automated run is still
  // debuggable the same way: colmap/database.db, result.ply, and this container's own stdout/stderr all land here.
  const jobDir = path.resolve(process.cwd(), "..", "worker", "jobdir", params.jobId);
  mkdirSync(jobDir, { recursive: true });
  const log = openSync(path.join(jobDir, "worker.log"), "a");

  const child = spawn(
    "podman",
    [
      "run",
      "--rm",
      "--security-opt=label=disable",
      "--device",
      "nvidia.com/gpu=all",
      "-e",
      `JOB_ID=${params.jobId}`,
      "-e",
      `SPLAT_ID=${params.splatId}`,
      "-e",
      `CALLBACK_TOKEN=${params.callbackToken}`,
      // Inside the container "localhost" is the container itself, not the host running `next dev` — this is Podman's
      // alias for the host, matching worker/.env's APP_PUBLIC_URL per .env.example.
      "-e",
      "APP_PUBLIC_URL=http://host.containers.internal:3000",
      "-e",
      `UPLOADS_BUCKET=${env.UPLOADS_BUCKET}`,
      "-e",
      `SPLATS_BUCKET=${env.SPLATS_BUCKET}`,
      "-e",
      `AWS_ACCESS_KEY_ID=${accessKeyId}`,
      "-e",
      `AWS_SECRET_ACCESS_KEY=${secretAccessKey}`,
      "-e",
      `AWS_DEFAULT_REGION=${env.AWS_REGION}`,
      "-v",
      `${jobDir}:/tmp/job`,
      "splat-worker:dev",
    ],
    { detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
}
