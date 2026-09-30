/**
 * Whether GPU processing is paused for the whole site.
 *
 * An SWR hook over GET /api/v1/processing, polled once a minute, which is how long the server caches the setting. The
 * new-splat form and the splat page's Start and Build cards use it to warn before anyone uploads or clicks. It reads as
 * not paused until the first answer arrives, so the notice never flashes on a normal load. The process and train routes
 * still refuse with a 503 if processing is switched off in between.
 */

"use client";

import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";

import { apiFetch } from "@/lib/apiFetch";
import { requireToken } from "@/lib/requireToken";
import type { ProcessingStatus } from "@/lib/types";

const POLL_MS = 60 * 1000;

export function useProcessingPaused(): boolean {
  const { getToken } = useAuth();
  const { data } = useSWR(
    "processing",
    async () => apiFetch<ProcessingStatus>("/api/v1/processing", "GET", await requireToken(getToken)),
    { refreshInterval: POLL_MS },
  );

  return data?.enabled === false;
}
