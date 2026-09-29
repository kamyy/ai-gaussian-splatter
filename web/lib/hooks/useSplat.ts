/**
 * Fetches one splat.
 *
 * An SWR hook over GET /api/v1/splats/[splatId]. The splat's page refetches it when its latest job ends, because the
 * worker's final callback updates the splat too.
 */

"use client";

import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";

import { apiFetch } from "@/lib/apiFetch";
import { requireToken } from "@/lib/requireToken";
import type { Splat } from "@/lib/types";

export function useSplat(splatId: string) {
  const { getToken } = useAuth();

  return useSWR(["splat", splatId], async () =>
    apiFetch<Splat>(`/api/v1/splats/${splatId}`, "GET", await requireToken(getToken)),
  );
}
