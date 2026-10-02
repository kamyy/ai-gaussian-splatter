/**
 * Serves /sitemap.xml, the list of pages search engines should crawl.
 *
 * It lists the / landing page, the /privacy and /terms pages, and the share page of each showcase example, the only
 * share pages that allow indexing (web/app/(public)/preview/splats/[id]/page.tsx). Search engines could find the
 * examples by following the landing page's links, but a sitemap gets a new one crawled sooner.
 */

import type { MetadataRoute } from "next";

import { getExampleSplats } from "@/lib/server/data";
import { getEnv } from "@/lib/server/env";
import { getRuntimeSettings } from "@/lib/server/runtimeSettings";
import type { ExampleSplat } from "@/lib/types";

/** Reads APP_ORIGIN and the database per request. Neither is available during `next build`. */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const { APP_ORIGIN } = getEnv();

  // A failed read still lists the landing page, the same fallback web/app/page.tsx makes.
  let exampleSplats: ExampleSplat[] = [];
  try {
    const { showcaseClerkUserId } = await getRuntimeSettings();
    if (showcaseClerkUserId !== null) {
      exampleSplats = await getExampleSplats(showcaseClerkUserId);
    }
  } catch (err) {
    console.error("Couldn't load the sitemap's examples", err);
  }

  return [
    { url: new URL("/", APP_ORIGIN).toString() },
    { url: new URL("/privacy", APP_ORIGIN).toString() },
    { url: new URL("/terms", APP_ORIGIN).toString() },
    ...exampleSplats.map(splat => ({ url: new URL(`/preview/splats/${splat.id}`, APP_ORIGIN).toString() })),
  ];
}
