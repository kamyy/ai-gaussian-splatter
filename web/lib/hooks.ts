"use client";

// SWR hooks — owns all server-derived data (splats list, job status via
// refreshInterval, gallery data). SWR rather than React Query because it is
// lighter, and job-status polling is the one piece of async complexity here
// worth a fetching library over a hand-rolled setInterval/useEffect.

import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";

import { getLatestJob, getSplat, listSplats } from "./api";
import type { JobRead, JobStatus } from "./types";

// Poll rate per phase; 0 is how SWR is told to stop. uploading_result can
// finish inside 30s, so a poll often steps over it and completion shows up to
// 30s late — accepted, since the phases before it run for minutes.
const JOB_POLL_INTERVAL_MS: Record<JobStatus, number> = {
  queued: 30_000,
  launching: 30_000,
  colmap_running: 30_000,
  training_running: 30_000,
  uploading_result: 3_000,
  complete: 0,
  failed: 0,
  cancelled: 0,
};

// Keep this at module scope — don't put it anywhere it could be recreated on
// a re-render, otherwise SWR sees a new identity and restarts the countdown.
function jobPollInterval(latestData: JobRead | undefined) {
  if (latestData === undefined) {
    return JOB_POLL_INTERVAL_MS.queued;
  }
  return JOB_POLL_INTERVAL_MS[latestData.status];
}

// Shared by every hook below: SWR only treats a thrown fetcher as an error,
// so a signed-out session (no token) has to throw rather than return.
function tokenGuardedFetcher<T>(getToken: () => Promise<string | null>, fetcher: (token: string) => Promise<T>) {
  return async () => {
    const token = await getToken();
    if (token) {
      return fetcher(token);
    }
    throw new Error("Not signed in");
  };
}

export function useSplats() {
  const { getToken } = useAuth();
  return useSWR("splats", tokenGuardedFetcher(getToken, listSplats));
}

export function useSplat(splatId: string) {
  const { getToken } = useAuth();
  return useSWR(
    ["splat", splatId],
    tokenGuardedFetcher(getToken, token => getSplat(token, splatId)),
  );
}

export function useJobStatus(splatId: string) {
  const { getToken } = useAuth();
  return useSWR(
    ["job-status", splatId],
    tokenGuardedFetcher(getToken, token => getLatestJob(token, splatId)),
    {
      refreshInterval: jobPollInterval,
    },
  );
}
