/**
 * Fetches the signed-in user's library of splats.
 *
 * An SWR hook over GET /api/v1/splats. SWR caches the response, so returning to the library shows it straight away
 * while it refreshes.
 */

"use client";

import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";

import { apiFetch } from "@/lib/apiFetch";
import { requireToken } from "@/lib/requireToken";
import type { SplatListItem } from "@/lib/types";

export function useSplats() {
  const { getToken } = useAuth();

  return useSWR("splats", async () => apiFetch<SplatListItem[]>("/api/v1/splats", "GET", await requireToken(getToken)));
}
