/**
 * Fetches the camera positions COLMAP worked out for a splat's photos.
 *
 * An SWR hook over GET /api/v1/splats/[splatId]/cameras. COLMAP is the structure-from-motion tool in worker/ that works
 * out where each photo was taken. The splat's page uses the result to draw the cameras and to fly the view to one.
 */

"use client";

import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";

import { apiFetch } from "@/lib/apiFetch";
import { requireToken } from "@/lib/requireToken";
import type { CameraPose } from "@/lib/types";

/**
 * enabled is the caller's knowledge that the reconstruct stage has run. A 404 after that is a job reconstructed before
 * the worker wrote camera poses, which retrying won't change, so errors aren't retried.
 */
export function useCameras(splatId: string, enabled: boolean) {
  const { getToken } = useAuth();

  return useSWR(
    enabled ? ["cameras", splatId] : null,
    async () => apiFetch<CameraPose[]>(`/api/v1/splats/${splatId}/cameras`, "GET", await requireToken(getToken)),
    { shouldRetryOnError: false },
  );
}
