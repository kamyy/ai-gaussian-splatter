"use client";

import { useAuth } from "@clerk/nextjs";
import useSWR from "swr";

import { apiFetch } from "@/lib/apiFetch";
import { requireToken } from "@/lib/requireToken";
import type { PhotoListItem } from "@/lib/types";

export function usePhotos(splatId: string) {
  const { getToken } = useAuth();

  return useSWR(["photos", splatId], async () =>
    apiFetch<PhotoListItem[]>(`/api/v1/splats/${splatId}/photos`, "GET", await requireToken(getToken)),
  );
}
