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
