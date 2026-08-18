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

export function useSplats() {
  const { getToken } = useAuth();

  const key = "splats";

  const fetcher = async () => {
    const token = await getToken();
    if (token) {
      return listSplats(token);
    }
    throw new Error("Not signed in");
  };

  return useSWR(key, fetcher);
}

export function useSplat(splatId: string) {
  const { getToken } = useAuth();

  const key = splatId ? ["splat", splatId] : null;

  const fetcher = async () => {
    const token = await getToken();
    if (token) {
      return getSplat(token, splatId);
    }
    throw new Error("Not signed in");
  };

  return useSWR(key, fetcher);
}

export function useJobStatus(splatId: string) {
  const { getToken } = useAuth();

  const key = splatId ? ["job-status", splatId] : null;

  const fetcher = async () => {
    const token = await getToken();
    if (token) {
      return getLatestJob(token, splatId);
    }
    throw new Error("Not signed in");
  };

  return useSWR(key, fetcher, {
    refreshInterval: jobPollInterval,
  });
}
