import type { Splat } from "./types";

// Shared by web/app/(authenticated)/splats/page.tsx and web/app/(authenticated)/splats/[id]/page.tsx: a splat with a
// finished train job is ready to view as a Gaussian Splat, anything earlier only has a point cloud (or nothing) to
// show yet.
export function defaultSubRoute(splat: Splat): "point-cloud" | "splat" {
  return splat.status === "complete" ? "splat" : "point-cloud";
}
