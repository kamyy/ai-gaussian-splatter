/**
 * Launches, looks up and stops the GPU instances that run worker jobs.
 *
 * Each worker-job stage (reconstruct, then train) runs on its own EC2 spot instance, a discounted AWS virtual machine
 * that AWS can reclaim. This file starts one directly, with no job queue in between, passing it a startup script that
 * pulls the worker's container image and runs the stage. The instance profile these launches pass is defined in
 * infra/worker_iam.tf. In local dev it can run the worker container on this machine instead.
 */

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, openSync } from "node:fs";
import path from "node:path";

import {
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";

import type { CropBox } from "@/lib/types";
import { getEnv } from "./env";
import type { RuntimeSettings } from "./runtimeSettings";

/**
 * The tag each worker instance carries its own lifetime ceiling in. infra/lambda/worker_sweeper.py reads the same key,
 * so the two must match.
 */
const LIFETIME_TAG_KEY = "MaxLifetimeMinutes";

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
  trainingIterations?: number;
  cropBox?: CropBox;
}

function renderUserData(p: UserDataParams): string {
  // Single-quoted in the script. The train route's schema has already reduced the box to numbers, so its JSON holds no
  // quote of either kind.
  const cropBoxVar = p.cropBox ? `CROP_BOX='${JSON.stringify(p.cropBox)}'\n` : "";
  const cropBoxArg = p.cropBox ? `    -e CROP_BOX="$CROP_BOX" \\\n` : "";
  const iterationsArg = p.trainingIterations ? `    -e TRAINING_ITERATIONS=${p.trainingIterations} \\\n` : "";

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

# Epoch milliseconds. User-data starts once the instance has booted, so the worker reports this to split the stage's
# start-up into boot and image pull (web/lib/stageTimings.ts).
BOOTED_AT="$(date +%s%3N)"

# Plaintext, and EC2 user-data is readable by anyone holding ec2:DescribeInstances. The token is per-job and only
# authorizes status updates on that one job (web/lib/server/auth.ts), which is what bounds this.
CALLBACK_TOKEN="${p.callbackToken}"
JOB_ID="${p.jobId}"
SPLAT_ID="${p.splatId}"
APP_PUBLIC_URL="${p.appPublicUrl}"
UPLOADS_BUCKET="${p.uploadsBucket}"
SPLATS_BUCKET="${p.splatsBucket}"
STAGE="${p.stage}"
${cropBoxVar}
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
    -e BOOTED_AT="$BOOTED_AT" \\
${iterationsArg}${cropBoxArg}    ${p.workerImageUri}
`;
}

/**
 * infra/web.tf sets these from its ECR repository once infra/ is deployed. The placeholders are for local development
 * before a deploy. The stages run different images. worker/Dockerfile's reconstruct target carries COLMAP and no torch,
 * and its train target carries torch and gsplat and no COLMAP, so each stage pulls only what it runs. Called by
 * web/app/api/v1/splats/[splatId]/process/route.ts and web/app/api/v1/splats/[splatId]/train/route.ts.
 */
export function workerImageUri(stage: WorkerStage): string {
  if (stage === "reconstruct") {
    return process.env.WORKER_RECONSTRUCT_IMAGE_URI ?? "REPLACE_WITH_ECR_IMAGE_URI";
  }

  return process.env.WORKER_TRAIN_IMAGE_URI ?? "REPLACE_WITH_ECR_IMAGE_URI";
}

export function ecrRegistry(): string {
  return process.env.ECR_REGISTRY ?? "REPLACE_WITH_ECR_REGISTRY";
}

/**
 * Runs the worker against the caller's own GPU via Podman instead of launching a real EC2 spot instance. See
 * launchJobLocal() below and "Triggering the worker from pnpm dev" in RUNBOOK.md.
 */
export function localLaunchEnabled(): boolean {
  return process.env.WORKER_LOCAL_LAUNCH === "true";
}

/**
 * A per-job token rather than one shared secret, so a compromised instance can only change the one job it was launched
 * for.
 *
 * It is the base64url encoding of 32 random bytes, matching Python's secrets.token_urlsafe(32).
 */
export function generateCallbackToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Launches the spot worker instance and returns its instance ID. The instance type, the lifetime ceiling and the
 * training iterations come from the runtime settings the caller read.
 */
export async function launchJob(params: {
  jobId: string;
  splatId: string;
  callbackToken: string;
  stage: WorkerStage;
  workerImageUri: string;
  ecrRegistry: string;
  settings: RuntimeSettings;
  cropBox?: CropBox;
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
    maxLifetimeMinutes: params.settings.workerMaxLifetimeMinutes,
    trainingIterations: params.stage === "train" ? params.settings.trainingIterations : undefined,
    cropBox: params.cropBox,
  });

  const response = await ec2.send(
    new RunInstancesCommand({
      ImageId: env.WORKER_AMI_ID,
      InstanceType: (params.stage === "reconstruct"
        ? params.settings.reconstructInstanceType
        : params.settings.trainInstanceType) as never,
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
            // The sweeper and web/lib/server/reconcileJob.ts judge this instance by the ceiling it was launched with,
            // so lowering the setting later never cuts short a stage already running.
            { Key: LIFETIME_TAG_KEY, Value: String(params.settings.workerMaxLifetimeMinutes) },
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
 * A worker instance's EC2 state name (pending, running, shutting-down, terminated, …), launch time and lifetime
 * ceiling, or null when EC2 no longer knows the instance. EC2 forgets a terminated instance about an hour after it
 * ends. The ceiling is null when the instance's tag is missing or doesn't parse.
 */
export async function describeWorker(
  instanceId: string,
): Promise<{ state: string; launchTime: Date; maxLifetimeMinutes: number | null } | null> {
  const ec2 = new EC2Client({ region: getEnv().AWS_REGION });
  try {
    const response = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const instance = response.Reservations?.[0]?.Instances?.[0];
    if (instance?.State?.Name === undefined || instance.LaunchTime === undefined) {
      return null;
    }

    const lifetimeTag = instance.Tags?.find(tag => tag.Key === LIFETIME_TAG_KEY)?.Value;
    const maxLifetimeMinutes = lifetimeTag !== undefined && /^\d+$/.test(lifetimeTag) ? Number(lifetimeTag) : null;

    return { state: instance.State.Name, launchTime: instance.LaunchTime, maxLifetimeMinutes };
  } catch (err) {
    if (err instanceof Error && err.name === "InvalidInstanceID.NotFound") {
      return null;
    }

    throw err;
  }
}

/**
 * Stops a worker instance ahead of its own self-termination, for a cancelled or deleted splat. An instance EC2 no
 * longer knows about has already gone, which is the outcome wanted. infra/web.tf's TerminateWorker grant only covers
 * instances carrying the worker tag launchJob() applies.
 */
export async function terminateWorker(instanceId: string): Promise<void> {
  const ec2 = new EC2Client({ region: getEnv().AWS_REGION });
  try {
    await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
  } catch (err) {
    if (err instanceof Error && err.name === "InvalidInstanceID.NotFound") {
      return;
    }

    throw err;
  }
}

function localContainerName(jobId: string): string {
  return `splat-worker-${jobId}`;
}

/**
 * launchJobLocal()'s counterpart to terminateWorker(). Fire-and-forget: a container that already exited (--rm removed
 * it) makes podman fail, which is the outcome wanted.
 */
export function stopLocalWorker(jobId: string): void {
  execFile("podman", ["rm", "--force", localContainerName(jobId)], () => {});
}

/**
 * Local-dev replacement for launchJob(). It runs the worker image on the caller's own GPU with Podman instead of
 * launching a real EC2 spot instance. Both launch routes only call it when WORKER_LOCAL_LAUNCH is set
 * (web/app/api/v1/splats/[splatId]/process/route.ts and web/app/api/v1/splats/[splatId]/train/route.ts). Production
 * can't reach it, because the ECS task has neither a podman binary nor a GPU.
 *
 * Like the EC2 launch it replaces, it doesn't wait for the container. The worker reports its own progress back through
 * APP_PUBLIC_URL and CALLBACK_TOKEN (worker/pipeline/status.py).
 */
export function launchJobLocal(params: {
  jobId: string;
  splatId: string;
  callbackToken: string;
  stage: WorkerStage;
  trainingIterations?: number;
  cropBox?: CropBox;
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
      "--name",
      localContainerName(params.jobId),
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
      // Inside the container, "localhost" is the container itself, not the host running `next dev`.
      // host.containers.internal is Podman's alias for the host, the same APP_PUBLIC_URL scripts/lib/worker.sh passes
      // for its local runs.
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
      ...(params.trainingIterations ? ["-e", `TRAINING_ITERATIONS=${params.trainingIterations}`] : []),
      ...(params.cropBox ? ["-e", `CROP_BOX=${JSON.stringify(params.cropBox)}`] : []),
      "-v",
      `${jobDir}:/tmp/job`,
      // worker/Dockerfile builds one image per stage, so this picks the same one scripts/lib/worker.sh's
      // worker_build_image tags. Running the wrong stage's image fails inside the container, where only worker.log
      // shows it.
      `splat-worker-${params.stage}:dev`,
    ],
    { detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
}
