import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";

import { EC2Client, RunInstancesCommand } from "@aws-sdk/client-ec2";

import { getEnv } from "./env";

// Direct spot-instance-per-job launch — no SQS/Batch/Step Functions. The instance profile these launches pass is
// scoped externally, in infra/worker_iam.tf.

type WorkerStage = "reconstruct" | "train";

interface UserDataParams {
  callbackToken: string;
  jobId: string;
  splatId: string;
  appPublicUrl: string;
  uploadsBucket: string;
  splatsBucket: string;
  stage: WorkerStage;
  workerImageUri: string;
  ecrRegistry: string;
  awsRegion: string;
  maxLifetimeMinutes: number;
}

function renderUserData(p: UserDataParams): string {
  return `#!/bin/bash
set -euo pipefail

# Hard ceiling independent of everything below: a failed docker login/pull, or a hang inside the container, would
# otherwise leave this instance running (and billing) forever, since worker/pipeline/instance.py's own
# self-terminate never gets a chance to run in either case. Scheduled before any of the failure-prone steps.
# InstanceInitiatedShutdownBehavior=terminate on the launch (below) is what makes this actually terminate the
# instance instead of just stopping it. A normal job still finishes and self-terminates well before this fires.
# If the ceiling can't be scheduled, power off now instead. Under set -e a bare failure here would exit with no job
# and no ceiling, billing until someone notices. -f skips systemd, in case systemd is why shutdown failed.
shutdown -h +${p.maxLifetimeMinutes} || poweroff -f

# Plaintext, and EC2 user-data is readable by anyone holding ec2:DescribeInstances. The token is per-job and only
# authorizes status updates on that one job (web/lib/server/auth.ts), which is what bounds this.
CALLBACK_TOKEN="${p.callbackToken}"
JOB_ID="${p.jobId}"
SPLAT_ID="${p.splatId}"
APP_PUBLIC_URL="${p.appPublicUrl}"
UPLOADS_BUCKET="${p.uploadsBucket}"
SPLATS_BUCKET="${p.splatsBucket}"
STAGE="${p.stage}"

$(aws ecr get-login --no-include-email --region ${p.awsRegion}) || \\
    aws ecr get-login-password --region ${p.awsRegion} | docker login --username AWS --password-stdin ${p.ecrRegistry}

docker run --rm --gpus all \\
    -e JOB_ID="$JOB_ID" \\
    -e SPLAT_ID="$SPLAT_ID" \\
    -e CALLBACK_TOKEN="$CALLBACK_TOKEN" \\
    -e APP_PUBLIC_URL="$APP_PUBLIC_URL" \\
    -e UPLOADS_BUCKET="$UPLOADS_BUCKET" \\
    -e SPLATS_BUCKET="$SPLATS_BUCKET" \\
    -e STAGE="$STAGE" \\
    ${p.workerImageUri}
`;
}

// Populated from infra/'s ECR repository output once infra is deployed. Placeholders for local/pre-deploy development.
// The stages run different images. worker/Dockerfile's reconstruct target carries COLMAP and no torch, and its train
// target carries torch and gsplat and no COLMAP, so each stage pulls only what it runs.
// Called by web/app/api/v1/splats/[splatId]/process/route.ts and web/app/api/v1/splats/[splatId]/train/route.ts.
export function workerImageUri(stage: WorkerStage): string {
  if (stage === "reconstruct") {
    return process.env.WORKER_RECONSTRUCT_IMAGE_URI ?? "REPLACE_WITH_ECR_IMAGE_URI";
  }
  return process.env.WORKER_TRAIN_IMAGE_URI ?? "REPLACE_WITH_ECR_IMAGE_URI";
}

export function ecrRegistry(): string {
  return process.env.ECR_REGISTRY ?? "REPLACE_WITH_ECR_REGISTRY";
}

// Runs the worker against the caller's own GPU via Podman instead of launching a real EC2 spot instance. See
// launchJobLocal() below and "Triggering the worker from pnpm dev" in RUNBOOK.md.
export function localLaunchEnabled(): boolean {
  return process.env.WORKER_LOCAL_LAUNCH === "true";
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

/**
 * How long after boot renderUserData's `shutdown -h` terminates a worker, whatever its job is doing. It caps
 * worst-case billing and is not a tuned SLA. No job's wall clock has been measured yet, so 2 hours is a rough guess
 * generous over the expected job. Revisit it once real numbers exist.
 */
export const WORKER_MAX_LIFETIME_MINUTES = 120;

/** Launches the spot worker instance and returns its instance ID. */
export async function launchJob(params: {
  jobId: string;
  splatId: string;
  callbackToken: string;
  stage: WorkerStage;
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
    stage: params.stage,
    workerImageUri: params.workerImageUri,
    ecrRegistry: params.ecrRegistry,
    awsRegion: env.AWS_REGION,
    maxLifetimeMinutes: WORKER_MAX_LIFETIME_MINUTES,
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
      // The pipeline runs in a container on default bridge networking, one hop further from IMDS than the host. At
      // EC2's default hop limit of 1, worker/pipeline/instance.py cannot read its own instance ID and silently skips
      // self-termination, and the instance bills until someone notices (AGENTS.md). HttpTokens is only safe paired
      // with the raised limit, since on its own it breaks the container's credentials too.
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
            // Must match infra/locals.tf's worker_tag_key/worker_tag_value and infra/worker_iam.tf's self-termination
            // grant. That's a separate Terraform config, so the constant can't be imported directly, and the two must
            // stay in sync by hand.
            { Key: "Role", Value: "worker" },
            { Key: "JobId", Value: params.jobId },
          ],
        },
      ],
      // Without this, renderUserData's scheduled `shutdown -h` would only stop the instance (AWS's default), leaving
      // it to bill EBS storage and block cleanup instead of going away.
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
 * launching a real EC2 spot instance. Both launch routes gate it behind WORKER_LOCAL_LAUNCH
 * (web/app/api/v1/splats/[splatId]/process/route.ts and web/app/api/v1/splats/[splatId]/train/route.ts). It is never
 * reachable in production,
 * where the ECS task has neither a podman binary nor a GPU.
 *
 * Fire-and-forget like the EC2 launch it replaces: the worker reports its own progress back over
 * APP_PUBLIC_URL/CALLBACK_TOKEN (worker/pipeline/status.py), so this function doesn't wait on the container.
 */
export function launchJobLocal(params: {
  jobId: string;
  splatId: string;
  callbackToken: string;
  stage: WorkerStage;
}): void {
  const env = getEnv();
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set to launch the worker locally");
  }

  // repo-root/worker/jobdir/<jobId>, next to the worker/jobdir scripts/dev/worker-reconstruct.sh uses, so a local
  // automated run is still debuggable the same way: colmap/database.db, result.ply, and this container's own
  // stdout/stderr all land here.
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
      "-e",
      `STAGE=${params.stage}`,
      // Inside the container "localhost" is the container itself, not the host running `next dev` — this is Podman's
      // alias for the host, matching the APP_PUBLIC_URL scripts/lib/worker.sh passes for its local runs.
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
