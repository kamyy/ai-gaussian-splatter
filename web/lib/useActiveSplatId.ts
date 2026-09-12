"use client";

import { useParams } from "next/navigation";

// Shared by web/components/layout/AuthHeader.tsx (which splat's name/status to show) and
// web/components/splats/SplatCarouselCard.tsx (which carousel card is the one already open). useParams() returns
// every dynamic segment matched by the current route regardless of which layout level calls it, so this resolves
// correctly from AuthHeader even though it's rendered above the [id] segment in
// web/app/(authenticated)/splats/layout.tsx.
export function useActiveSplatId(): string | null {
  const params = useParams<{ id?: string }>();
  return params.id ?? null;
}
