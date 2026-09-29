/**
 * Fetches a splat's latest worker job, and keeps polling it while the job runs.
 *
 * An SWR hook over GET /api/v1/splats/[splatId]/jobs/latest. The splat's page polls it to show the pipeline's progress.
 * Polling speeds up near the end of a run and stops once the job has ended.
 */

"use client";

import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";

import { apiFetch } from "@/lib/apiFetch";
import { requireToken } from "@/lib/requireToken";
import type { JobStatus } from "@/lib/statuses";
import type { Job } from "@/lib/types";

// Poll rate per phase. 0 tells SWR to stop polling, and only an ended status may use it. SWR keys its polling effect on
// this function's identity rather than on the data, so once the function returns 0 it schedules no further timer, and
// only a remount starts one again. A later mutate() does not. A non-terminal status returning 0 would therefore freeze
// the job status for the rest of the job.
//
// uploading_result can finish inside 30s, so a poll often steps over it and completion shows up to 30s late. That is
// accepted, since the phases before it run for minutes.
const JOB_POLL_INTERVAL_MS: Record<JobStatus, number> = {
  queued: 30_000,
  launching: 30_000,
  reconstruction_running: 30_000,
  // Nothing moves here until the visitor clicks the check stage's build button, and that click mutates the cache
  // directly. Polling continues anyway: it is what leaves the timer armed for the training run the click starts.
  awaiting_training: 30_000,
  training_running: 30_000,
  uploading_result: 3_000,
  complete: 0,
  failed: 0,
  cancelled: 0,
};

// At module scope so every render hands SWR the same function identity. SWR keys its polling effect on that identity,
// so a fresh closure per render would tear down the pending timeout and restart the interval instead.
function refreshInterval(job: Job | undefined) {
  if (job) {
    return JOB_POLL_INTERVAL_MS[job.status];
  }

  return JOB_POLL_INTERVAL_MS.queued;
}

export function useLatestJob(splatId: string) {
  const { getToken } = useAuth();

  return useSWR(
    ["latest-job", splatId],
    async () => apiFetch<Job>(`/api/v1/splats/${splatId}/jobs/latest`, "GET", await requireToken(getToken)),
    {
      refreshInterval,
    },
  );
}
