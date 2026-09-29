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
