"use client";

// SWR hooks (plan §1: lib/hooks.ts) — owns all server-derived data (objects
// list, job status via refreshInterval, gallery data). See plan's context
// note on why SWR over React Query: lighter, Vercel-native, and this is the
// one piece of real async complexity (job-status polling) worth a fetching
// library rather than hand-rolled setInterval/useEffect.

import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";

import { getGallery, getLatestJob, getObject, listObjects } from "./api";
import { TERMINAL_JOB_STATUSES } from "./types";

const JOB_POLL_INTERVAL_MS = 4500;

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
    {
      refreshInterval: latestData => {
        if (latestData && TERMINAL_JOB_STATUSES.includes(latestData.status)) {
          return 0; // stop polling once terminal — plan §4
        }
        return JOB_POLL_INTERVAL_MS;
      },
    },
  );
}

export function useGallery() {
  return useSWR("gallery", getGallery);
}
