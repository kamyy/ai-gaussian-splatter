"use client";

// SWR hooks — owns all server-derived data (objects list, job status via
// refreshInterval, gallery data). SWR rather than React Query because it is
// lighter, and job-status polling is the one piece of async complexity here
// worth a fetching library over a hand-rolled setInterval/useEffect.

import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";

import { getLatestJob, getObject, listObjects } from "./api";
import { JOB_ENDED_STATUSES, type JobRead } from "./types";

const JOB_POLL_INTERVAL_MS = 4500;

// Keep this at module scope — don't put it anywhere it could be recreated on
// a re-render, otherwise SWR sees a new identity and restarts the countdown.
function jobPollInterval(latestData: JobRead | undefined) {
  if (latestData && JOB_ENDED_STATUSES.includes(latestData.status)) {
    return 0; // stop polling once the job has ended
  }
  return JOB_POLL_INTERVAL_MS;
}

export function useObjects() {
  const { getToken } = useAuth();
  return useSWR("objects", async () => {
    const token = await getToken();
    if (!token) {
      throw new Error("Not signed in");
    }
    return listObjects(token);
  });
}

export function useObject(objectId: string | undefined) {
  const { getToken } = useAuth();
  return useSWR(objectId ? ["object", objectId] : null, async () => {
    const token = await getToken();
    if (!token) {
      throw new Error("Not signed in");
    }
    return getObject(token, objectId as string);
  });
}

export function useJobStatus(objectId: string | undefined) {
  const { getToken } = useAuth();
  return useSWR(
    objectId ? ["job-status", objectId] : null,
    async () => {
      const token = await getToken();
      if (!token) {
        throw new Error("Not signed in");
      }
      return getLatestJob(token, objectId as string);
    },
    { refreshInterval: jobPollInterval },
  );
}
