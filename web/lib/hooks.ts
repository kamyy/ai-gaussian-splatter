"use client";

// SWR hooks for the splat, photo, camera, and job data the pages read. SWR rather than React Query because it is
// lighter. Job-status polling is the one piece of async complexity here worth a fetching library over a hand-rolled
// setInterval/useEffect.

import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";
import { apiFetch } from "./apiFetch";
import { requireToken } from "./requireToken";
import type { CameraPose, Job, JobStatus, PhotoListItem, Splat, SplatListItem } from "./types";

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

export function useSplats() {
  const { getToken } = useAuth();

  return useSWR("splats", async () => apiFetch<SplatListItem[]>("/api/v1/splats", "GET", await requireToken(getToken)));
}

export function useSplat(splatId: string) {
  const { getToken } = useAuth();

  return useSWR(["splat", splatId], async () =>
    apiFetch<Splat>(`/api/v1/splats/${splatId}`, "GET", await requireToken(getToken)),
  );
}

export function usePhotos(splatId: string) {
  const { getToken } = useAuth();

  return useSWR(["photos", splatId], async () =>
    apiFetch<PhotoListItem[]>(`/api/v1/splats/${splatId}/photos`, "GET", await requireToken(getToken)),
  );
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

// enabled is the caller's knowledge that the reconstruct stage has run. A 404 after that is a job reconstructed before
// the worker wrote camera poses, which retrying won't change, so errors aren't retried.
export function useCameras(splatId: string, enabled: boolean) {
  const { getToken } = useAuth();

  return useSWR(
    enabled ? ["cameras", splatId] : null,
    async () => apiFetch<CameraPose[]>(`/api/v1/splats/${splatId}/cameras`, "GET", await requireToken(getToken)),
    { shouldRetryOnError: false },
  );
}
