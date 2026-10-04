/**
 * Notices a worker job whose GPU instance has died, and fails it.
 *
 * A worker that crashes or is reclaimed never calls back to say so. Each time the splat's page polls its latest job,
 * this checks whether a job that has been quiet for a while still has a live instance, and marks it failed if not.
 */

import { and, eq } from "drizzle-orm";

import { JobStatus, SplatStatus } from "@/lib/statuses";
import { WORKER_RUNNING_STATUSES } from "./cancelJob";
import { getDb } from "./db";
import { jobs, splats } from "./db/schema";
import { isLocalDev } from "./env";
import { WORKER_MAX_LIFETIME_BOUNDS } from "./runtimeSettings";
import { describeWorker, terminateWorker } from "./workerLauncher";

// How long a job goes without a status callback before its instance is looked up. A healthy reconstruct stage can go
// many minutes between callbacks, so this only decides when to check, never on its own that the job is dead.
const CHECK_AFTER_MS = 15 * 60 * 1000;

// Past its lifetime ceiling, a still-running instance is one whose user-data `shutdown -h` never fired. The grace
// covers boot time, since the ceiling counts from when user-data runs rather than from launch.
// infra/lambda/worker_sweeper.py allows the same.
const OVERDUE_GRACE_MINUTES = 15;

const ALIVE_STATES = ["pending", "running"];

// Each instance is judged by the ceiling it was launched with. One without a readable lifetime tag gets the longest
// ceiling the setting allows, as the sweeper does.
function overdueAfterMs(maxLifetimeMinutes: number | null): number {
  return ((maxLifetimeMinutes ?? WORKER_MAX_LIFETIME_BOUNDS.max) + OVERDUE_GRACE_MINUTES) * 60 * 1000;
}

/**
 * Fails a job whose worker instance has gone without reporting a result, or that has run past the lifetime ceiling, so
 * the splat page stops showing it as in progress. An overdue instance is terminated first. Returns whether the job was
 * failed.
 *
 * web/app/api/v1/splats/[splatId]/jobs/latest/route.ts calls this on every poll of an in-progress job, so it looks the
 * instance up only once the job has gone CHECK_AFTER_MS without a callback.
 */
export async function reconcileJob(
  job: Pick<typeof jobs.$inferSelect, "id" | "status" | "updatedAt">,
): Promise<boolean> {
  if (!WORKER_RUNNING_STATUSES.includes(job.status) || isLocalDev()) {
    return false;
  }

  if (Date.now() - job.updatedAt.getTime() < CHECK_AFTER_MS) {
    return false;
  }

  const [row] = await getDb()
    .select({ splatId: jobs.splatId, ec2InstanceId: jobs.ec2InstanceId })
    .from(jobs)
    .where(eq(jobs.id, job.id))
    .limit(1);
  if (row === undefined || row.ec2InstanceId === null) {
    return false;
  }

  const { splatId, ec2InstanceId } = row;

  const instance = await describeWorker(ec2InstanceId);
  let errorMessage: string;
  if (instance === null || !ALIVE_STATES.includes(instance.state)) {
    errorMessage = "The worker stopped without reporting a result.";
  } else if (Date.now() - instance.launchTime.getTime() > overdueAfterMs(instance.maxLifetimeMinutes)) {
    await terminateWorker(ec2InstanceId);
    errorMessage = "The worker ran past its time limit and was stopped.";
  } else {
    return false;
  }

  // Both rows move together or not at all. The job write is conditional on the job still having the status and instance
  // this lookup judged. A reconstruct stage that finishes during the lookup moves to awaiting_training and terminates
  // its own instance, which the lookup would otherwise read as a dead worker. The same condition keeps a result or a
  // cancel that landed meanwhile.
  return getDb().transaction(async tx => {
    const failed = await tx
      .update(jobs)
      .set({ status: JobStatus.failed, errorMessage })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, job.status), eq(jobs.ec2InstanceId, ec2InstanceId)))
      .returning({ id: jobs.id });
    if (failed.length === 0) {
      return false;
    }

    await tx.update(splats).set({ status: SplatStatus.failed }).where(eq(splats.id, splatId));

    return true;
  });
}
