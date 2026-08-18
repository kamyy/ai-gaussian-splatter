"use client";

// SWR hooks — owns all server-derived data (splats list, job status via
// refreshInterval, gallery data). SWR rather than React Query because it is
// lighter, and job-status polling is the one piece of async complexity here
// worth a fetching library over a hand-rolled setInterval/useEffect.

import { useAuth } from "@clerk/nextjs";
import type { GetToken } from "@clerk/nextjs/types";
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
  if (latestData) {
    return JOB_POLL_INTERVAL_MS[latestData.status];
  }
  return JOB_POLL_INTERVAL_MS.queued;
}

function guardedFetch<T>(getToken: GetToken, fetcher: (token: string) => Promise<T>) {
  return async () => {
    const token = await getToken();
    if (!token) {
      // SWR only treats a thrown fetcher as an error — returning would surface as a successful load.
      throw new Error("Not signed in");
    }
    return fetcher(token);
  };
}

export function useSplats() {
  const { getToken } = useAuth();

  return useSWR("splats", guardedFetch(getToken, listSplats));
}

export function useSplat(splatId: string) {
  const { getToken } = useAuth();

  return useSWR(
    ["splat", splatId],
    guardedFetch(getToken, token => getSplat(token, splatId)),
  );
}

export function useJobStatus(splatId: string) {
  const { getToken } = useAuth();

  return useSWR(
    ["job-status", splatId],
    guardedFetch(getToken, token => getLatestJob(token, splatId)),
    {
      refreshInterval: jobPollInterval,
    },
  );
}
