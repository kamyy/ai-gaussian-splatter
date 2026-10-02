/**
 * Serves /robots.txt, which tells search engine crawlers what to skip and where the sitemap is.
 *
 * The signed-in pages under /splats only redirect a crawler to sign-in, and /api/ serves JSON, so crawlers are told to
 * skip both. Share pages that shouldn't be indexed opt out through their own metadata instead
 * (web/app/(public)/preview/splats/[id]/page.tsx).
 */

import type { MetadataRoute } from "next";

import { getEnv } from "@/lib/server/env";

/** Reads APP_ORIGIN per request, because it is unset during `next build`. */
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/splats"] },
    sitemap: new URL("/sitemap.xml", getEnv().APP_ORIGIN).toString(),
  };
}
