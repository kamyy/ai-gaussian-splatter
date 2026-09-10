"use client";

// SWR hooks — owns all server-derived data (splats list, job status via refreshInterval). SWR rather than React Query
// because it is lighter. Job-status polling is the one piece of async complexity here worth a fetching library over a
// hand-rolled setInterval/useEffect.

import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";
import { apiFetch } from "./apiFetch";
import type { Job, JobStatus, Splat } from "./types";

// Poll rate per phase; 0 is how SWR is told to stop, and only an ended status may use it. SWR keys its polling effect
// on this function's identity rather than on the data, so once the function returns 0 it schedules no further timer
// and nothing but a remount starts one again. A later mutate() does not. A non-terminal status returning 0 would
// therefore freeze the progress bar for the rest of the job.
//
// uploading_result can finish inside 30s, so a poll often steps over it and completion shows up to 30s late —
// accepted, since the phases before it run for minutes.
const JOB_POLL_INTERVAL_MS: Record<JobStatus, number> = {
  queued: 30_000,
  launching: 30_000,
  colmap_running: 30_000,
  // Nothing moves here until the user hits "Proceed to train", and that click mutates the cache directly. Polling
  // continues anyway: it is what leaves the timer armed for the training run the click starts.
  awaiting_training: 30_000,
  training_running: 30_000,
  uploading_result: 3_000,
  complete: 0,
  failed: 0,
  cancelled: 0,
};

function refreshInterval(job: Job | undefined) {
  // At  module scope so it doesn't recreate on a re-render.
  if (job) {
    return JOB_POLL_INTERVAL_MS[job.status];
  }
  return JOB_POLL_INTERVAL_MS.queued;
}

export function useSplats() {
  const { getToken } = useAuth();

  const fetcher = async () => {
    const token = await getToken();
    if (token) {
      return apiFetch<Splat[]>("/api/v1/splats", "GET", token);
    }
    throw new Error("Not signed in");
  };

  return useSWR("splats", fetcher);
}

export function useSplat(splatId: string) {
  const { getToken } = useAuth();

  const fetcher = async () => {
    const token = await getToken();
    if (token) {
      return apiFetch<Splat>(`/api/v1/splats/${splatId}`, "GET", token);
    }
    throw new Error("Not signed in");
  };

  return useSWR(["splat", splatId], fetcher);
}

export function useLatestJob(splatId: string) {
  const { getToken } = useAuth();

  const fetcher = async () => {
    const token = await getToken();
    if (token) {
      return apiFetch<Job>(`/api/v1/splats/${splatId}/jobs/latest`, "GET", token);
    }
    throw new Error("Not signed in");
  };

  return useSWR(["latest-job", splatId], fetcher, {
    refreshInterval,
  });
}
