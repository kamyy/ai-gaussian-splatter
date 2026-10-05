/**
 * Starts, looks up and stops the compute that runs a worker-job stage.
 *
 * A stage (reconstruct, then train) runs on an EC2 spot instance in production, or in a Podman container on this
 * machine in local dev. An EC2 spot instance is a discounted AWS virtual machine that AWS can reclaim. This file
 * starts either one directly, with no job queue in between. An EC2 launch passes a startup script that pulls the
 * worker's container image and runs the stage. The instance profile those launches pass is defined in
 * infra/worker_iam.tf.
 */

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";

import {
  DescribeInstancesCommand,
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";

import { getEnv, LOCAL_APP_ORIGIN } from "./env";
import type { RuntimeSettings } from "./runtimeSettings";

/**
 * The tag each worker instance carries its own lifetime ceiling in. infra/lambda/worker_sweeper.py reads the same key,
 * so the two must match.
 */
const LIFETIME_TAG_KEY = "MaxLifetimeMinutes";

/**
 * Local worker jobs stopped while their image was still building. stopLocalWorker() has no container to remove yet, so
 * launchJobLocal() checks this before it starts one.
 */
const stoppedLocalJobs = new Set<string>();

type WorkerStage = "reconstruct" | "train";

/**
 * What both launchJob() and launchJobLocal() take. The instance type, the lifetime ceiling and the training iterations
 * come from the runtime settings the caller read.
 */
export interface WorkerLaunch {
  jobId: string;
  splatId: string;
  callbackToken: string;
  stage: WorkerStage;
  settings: RuntimeSettings;
}

interface UserDataParams {
  callbackToken: string;
  jobId: string;
  splatId: string;
  appOrigin: string;
  uploadsBucket: string;
  splatsBucket: string;
  stage: WorkerStage;
  workerImageUri: string;
  ecrRegistry: string;
  awsRegion: string;
  logGroup: string;
  maxLifetimeMinutes: number;
  trainingIterations?: number;
}

function renderUserData(p: UserDataParams): string {
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

# Plaintext, and EC2 user-data is readable by anyone allowed to describe the instance's attributes. The token is per-job.
# It authorizes status updates on that one job, and S3 credentials for that one splat's files, which is what bounds
# this.
CALLBACK_TOKEN="${p.callbackToken}"
JOB_ID="${p.jobId}"
SPLAT_ID="${p.splatId}"
APP_ORIGIN="${p.appOrigin}"
UPLOADS_BUCKET="${p.uploadsBucket}"
SPLATS_BUCKET="${p.splatsBucket}"
STAGE="${p.stage}"

$(aws ecr get-login --no-include-email --region ${p.awsRegion}) || \\
    aws ecr get-login-password --region ${p.awsRegion} | docker login --username AWS --password-stdin ${p.ecrRegistry}

# Docker refuses to start a container whose awslogs stream it can't create, which would fail the stage with no output
# and leave this instance idle until the lifetime ceiling. Creating the stream first turns that into a logged error
# here, and the stage then runs without CloudWatch logs. Non-blocking mode keeps a later CloudWatch outage from
# stalling the pipeline's own writes to stdout.
LOG_OPTS=""
if aws logs create-log-stream --region ${p.awsRegion} --log-group-name ${p.logGroup} --log-stream-name "$JOB_ID-$STAGE"; then
    LOG_OPTS="--log-driver=awslogs --log-opt mode=non-blocking --log-opt awslogs-region=${p.awsRegion} --log-opt awslogs-group=${p.logGroup} --log-opt awslogs-stream=$JOB_ID-$STAGE"
fi

# LOG_OPTS is deliberately unquoted, so its words split into separate docker arguments. None of them holds a space.
docker run --rm --gpus all \\
    $LOG_OPTS \\
    -e JOB_ID="$JOB_ID" \\
    -e SPLAT_ID="$SPLAT_ID" \\
    -e CALLBACK_TOKEN="$CALLBACK_TOKEN" \\
    -e APP_ORIGIN="$APP_ORIGIN" \\
    -e UPLOADS_BUCKET="$UPLOADS_BUCKET" \\
    -e SPLATS_BUCKET="$SPLATS_BUCKET" \\
    -e STAGE="$STAGE" \\
    -e BOOTED_AT="$BOOTED_AT" \\
    -e S3_CREDENTIALS_FROM_APP=true \\
${iterationsArg}    ${p.workerImageUri}
`;
}

function ec2Client(): EC2Client {
  return new EC2Client({ region: getEnv().AWS_REGION });
}

/**
 * infra/web.tf sets these from its ECR repository once infra/ is deployed. The placeholders are for local development
 * before a deploy. The stages run different images. worker/Dockerfile's reconstruct target carries COLMAP and no torch,
 * and its train target carries torch and gsplat and no COLMAP, so each stage pulls only what it runs.
 */
function workerImageUri(stage: WorkerStage): string {
  if (stage === "reconstruct") {
    return process.env.WORKER_RECONSTRUCT_IMAGE_URI ?? "REPLACE_WITH_ECR_IMAGE_URI";
  }

  return process.env.WORKER_TRAIN_IMAGE_URI ?? "REPLACE_WITH_ECR_IMAGE_URI";
}

function ecrRegistry(): string {
  return process.env.ECR_REGISTRY ?? "REPLACE_WITH_ECR_REGISTRY";
}

/**
 * A per-worker-job token rather than one shared secret. A compromised instance can update that worker job's status,
 * and can read and write that splat's S3 objects.
 *
 * It is the base64url encoding of 32 random bytes, matching Python's secrets.token_urlsafe(32).
 */
export function generateCallbackToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Launches the spot worker instance and returns its instance ID. */
export async function launchJob(params: WorkerLaunch): Promise<string> {
  const env = getEnv();
  // launchJob runs only outside local dev, where getEnv() has already required the worker instance settings. The
  // schema still types them optional.
  const logGroup = env.WORKER_LOG_GROUP as string;
  const securityGroupId = env.WORKER_SECURITY_GROUP_ID as string;

  const userData = renderUserData({
    callbackToken: params.callbackToken,
    jobId: params.jobId,
    splatId: params.splatId,
    appOrigin: env.APP_ORIGIN,
    uploadsBucket: env.UPLOADS_BUCKET,
    splatsBucket: env.SPLATS_BUCKET,
    stage: params.stage,
    workerImageUri: workerImageUri(params.stage),
    ecrRegistry: ecrRegistry(),
    awsRegion: env.AWS_REGION,
    logGroup,
    maxLifetimeMinutes: params.settings.workerMaxLifetimeMinutes,
    trainingIterations: params.stage === "train" ? params.settings.trainingIterations : undefined,
  });

  const response = await ec2Client().send(
    new RunInstancesCommand({
      ImageId: env.WORKER_AMI_ID,
      InstanceType: (params.stage === "reconstruct"
        ? params.settings.reconstructInstanceType
        : params.settings.trainInstanceType) as never,
      MinCount: 1,
      MaxCount: 1,
      SubnetId: env.WORKER_SUBNET_ID,
      SecurityGroupIds: [securityGroupId],
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
  try {
    const response = await ec2Client().send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
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
  try {
    await ec2Client().send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
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
  stoppedLocalJobs.add(jobId);
  execFile("podman", ["rm", "--force", localContainerName(jobId)], () => {});
}

/**
 * Fails a local worker job whose image didn't build, through the same status callback the worker itself would have
 * called. web/lib/server/reconcileJob.ts returns immediately in local dev, so this callback is what marks the failure.
 */
function reportLocalBuildFailure(params: WorkerLaunch): void {
  fetch(`${LOCAL_APP_ORIGIN}/api/v1/internal/jobs/${params.jobId}/status`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${params.callbackToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "failed",
      error_message: `The splat-worker-${params.stage}:dev image didn't build. See worker/jobdir/${params.jobId}/worker.log.`,
    }),
  }).catch(() => {});
}

/**
 * Local-dev replacement for launchJob(). It builds the stage's worker image from worker/ and runs it on the caller's
 * own GPU with Podman, instead of launching a real EC2 spot instance. web/lib/server/worker.ts only calls it under
 * `pnpm dev`. Production can't reach it, because the ECS task has neither a podman binary nor a GPU.
 *
 * Like the EC2 launch it replaces, it doesn't wait for the container. The worker reports its own progress back through
 * APP_ORIGIN and CALLBACK_TOKEN (worker/pipeline/status.py).
 */
export function launchJobLocal(params: WorkerLaunch): void {
  const env = getEnv();
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set to launch the worker locally");
  }

  // repo-root/worker/jobdir/<jobId>, so a local run is debuggable from its files: colmap/database.db, result.ply, and
  // the build's and the container's own stdout/stderr all land here.
  const workerDir = path.resolve(process.cwd(), "..", "worker");
  const jobDir = path.join(workerDir, "jobdir", params.jobId);
  mkdirSync(jobDir, { recursive: true });
  const log = openSync(path.join(jobDir, "worker.log"), "a");
  // The train stage reuses its job's ID, so a stop recorded against an earlier stage mustn't block this one.
  stoppedLocalJobs.delete(params.jobId);

  // worker/Dockerfile builds one image per stage. It is rebuilt on every launch, so an edit to worker/ never runs a
  // stale image. An unchanged worker/ is all layer-cache hits and takes seconds.
  const image = `splat-worker-${params.stage}:dev`;
  const runArgs = [
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
    // Inside the container, "localhost" is the container itself. host.containers.internal is Podman's alias for the
    // host running `next dev`.
    "-e",
    "APP_ORIGIN=http://host.containers.internal:3000",
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
    ...(params.stage === "train" ? ["-e", `TRAINING_ITERATIONS=${params.settings.trainingIterations}`] : []),
    // The train stage's local-only switch from web/.env (worker/pipeline/config.py). EVAL_HOLDOUT scores the result
    // against held-back photos.
    ...(params.stage === "train" && process.env.EVAL_HOLDOUT === "true" ? ["-e", "EVAL_HOLDOUT=true"] : []),
    "-v",
    `${jobDir}:/tmp/job`,
    image,
  ];

  const build = spawn("podman", ["build", "--target", params.stage, "-t", image, workerDir], {
    stdio: ["ignore", log, log],
  });
  build.on("error", err => {
    writeSync(log, `\nCould not start podman build: ${err.message}\n`);
    reportLocalBuildFailure(params);
  });
  build.on("exit", code => {
    if (stoppedLocalJobs.delete(params.jobId)) {
      return;
    }
    if (code !== 0) {
      writeSync(log, `\npodman build exited with ${code}, so the worker didn't run.\n`);
      reportLocalBuildFailure(params);
      return;
    }

    const child = spawn("podman", runArgs, { detached: true, stdio: ["ignore", log, log] });
    child.unref();
  });
}
