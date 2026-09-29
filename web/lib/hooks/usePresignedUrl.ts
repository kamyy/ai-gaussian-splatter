/**
 * Fetches a time-limited download link for one of the viewer's 3D files, and keeps it fresh.
 *
 * The 3D files live in S3 (AWS's file storage), and the viewer loads them through presigned URLs, links that stop
 * working after 15 minutes. This hook fetches one from the API and replaces it well before it expires.
 */

"use client";

import { useAuth } from "@clerk/nextjs";
import { useState } from "react";
import useSWR from "swr";

import { apiFetch } from "@/lib/apiFetch";
import { requireToken } from "@/lib/requireToken";

// A presigned URL is only read once, when a scene mounts, so a revalidated one that has since been re-minted is never
// reloaded (web/components/viewer/SplatViewer.tsx). What matters is that the URL in hand is still valid whenever a
// scene next mounts, such as on a mode switch.
//
// web/lib/server/s3.ts presigns for 15 minutes, so each URL is re-minted well inside that while the page is open.
const URL_REFRESH_MS = 5 * 60_000;
// SWR's cache outlives the page, so a return visit starts from the last visit's URL, which may have expired. One
// fetched longer than this before the page mounted is not used, and the page waits for SWR's revalidation instead.
const URL_MAX_AGE_AT_MOUNT_MS = 10 * 60_000;

/** Fetches the presigned URL at path while key is set, and returns undefined until one is fresh enough to mount. */
export function usePresignedUrl(key: string[] | null, path: string) {
  const { getToken } = useAuth();
  const [mountedAt] = useState(Date.now);
  const { data, error } = useSWR(
    key,
    async () => ({ url: await apiFetch<string>(path, "GET", await requireToken(getToken)), fetchedAt: Date.now() }),
    { refreshInterval: URL_REFRESH_MS },
  );
  const url = data && data.fetchedAt > mountedAt - URL_MAX_AGE_AT_MOUNT_MS ? data.url : undefined;
  return { url, error };
}
