/**
 * Cancels a splat's active worker job and stops its GPU instance.
 *
 * Used by the cancel route, and by the delete route before a splat is removed. The update only lands while the job
 * hasn't already ended, so a cancel racing the worker's final callback can't bring an ended job back.
 */

import { and, desc, eq, notInArray } from "drizzle-orm";

import { JOB_ENDED_STATUSES, JobStatus } from "@/lib/statuses";
import { getDb } from "./db";
import { jobs } from "./db/schema";
import { jobColumns } from "./selects";
import { stopWorker } from "./worker";

/**
 * Statuses where a worker instance may be running for the job. awaiting_training is absent: the reconstruct instance
 * has already terminated itself and the train instance hasn't launched.
 */
export const WORKER_RUNNING_STATUSES: JobStatus[] = [
  JobStatus.queued,
  JobStatus.launching,
  JobStatus.reconstruction_running,
  JobStatus.training_running,
  JobStatus.uploading_result,
];

/**
 * Stops the splat's active worker job, if it has one, and marks it cancelled. Returns the cancelled job, or undefined
 * when there was nothing to cancel.
 *
 * The worker is stopped before the row is marked, so a failure to stop it leaves the job active for the caller to
 * retry rather than reporting a cancel while the instance keeps billing. The mark is conditional on the job not having
 * ended in the meantime, so a job that completed during the stop keeps its result.
 */
export async function cancelActiveJob(splatId: string) {
  const [job] = await getDb()
    .select()
    .from(jobs)
    .where(and(eq(jobs.splatId, splatId), notInArray(jobs.status, JOB_ENDED_STATUSES)))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  if (job === undefined) {
    return undefined;
  }

  if (WORKER_RUNNING_STATUSES.includes(job.status)) {
    await stopWorker(job.id, job.ec2InstanceId);
  }

  const [cancelled] = await getDb()
    .update(jobs)
    .set({ status: JobStatus.cancelled, errorMessage: "Cancelled." })
    .where(and(eq(jobs.id, job.id), notInArray(jobs.status, JOB_ENDED_STATUSES)))
    .returning(jobColumns);
  return cancelled;
}
