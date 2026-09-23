"use client";

import { useRouter } from "next/navigation";
import { use, useEffect } from "react";

import { useSplat } from "@/lib/hooks";
import { defaultSubRoute } from "@/lib/splatDefaultRoute";

// The ancestor layout (web/app/(authenticated)/splats/[id]/layout.tsx) already gates the loading/not-found states,
// so by the time this renders, `splat` is present. This page's only job is to pick which of the two sub-routes a
// bare /splats/[id] visit — from the carousel, or a bookmark — should land on. Photos aren't a sub-route: they live
// in the PhotoFilmstrip that layout renders over every sub-route.
export default function SplatDefaultRoutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { data: splat } = useSplat(id);

  useEffect(() => {
    if (splat) {
      router.replace(`/splats/${id}/${defaultSubRoute(splat)}`);
    }
  }, [splat, id, router]);

  return <div className="h-full animate-pulse bg-divider" />;
}
