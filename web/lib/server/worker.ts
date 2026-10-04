/**
 * Starts and stops a worker-job stage, wherever this deployment runs it.
 *
 * In production a stage runs on an EC2 spot instance. In local dev (`pnpm dev`), it runs in a Podman container on this
 * machine instead. web/lib/server/workerLauncher.ts implements both. This file picks between them, so the routes that
 * launch, cancel or delete a worker job never branch on it themselves.
 */

import { isLocalDev } from "./env";
import { launchJob, launchJobLocal, stopLocalWorker, terminateWorker, type WorkerLaunch } from "./workerLauncher";

/** Returns the stage's EC2 instance ID, or null for a local container, which has none. */
export async function launchWorker(params: WorkerLaunch): Promise<string | null> {
  if (isLocalDev()) {
    launchJobLocal(params);
    return null;
  }

  return launchJob(params);
}

/** Stops the job's worker, if it has one. A job with no instance ID yet has nothing on EC2 to stop. */
export async function stopWorker(jobId: string, ec2InstanceId: string | null): Promise<void> {
  if (isLocalDev()) {
    stopLocalWorker(jobId);
  } else if (ec2InstanceId !== null) {
    await terminateWorker(ec2InstanceId);
  }
}
