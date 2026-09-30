/**
 * Serves /sitemap.xml, the list of pages search engines should crawl.
 *
 * It lists the / landing page and the share page of each showcase example, the only share pages that allow indexing
 * (web/app/(public)/preview/splats/[id]/page.tsx). Search engines could find the examples by following the landing
 * page's links, but a sitemap gets a new one crawled sooner.
 */

import type { MetadataRoute } from "next";

import { getExampleSplats } from "@/lib/server/data";
import { getEnv } from "@/lib/server/env";
import type { ExampleSplat } from "@/lib/types";

/** Reads APP_PUBLIC_URL and the database per request. Neither is available during `next build`. */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const { APP_PUBLIC_URL, SHOWCASE_CLERK_USER_ID } = getEnv();

  // A failed read still lists the landing page, the same fallback web/app/page.tsx makes.
  let exampleSplats: ExampleSplat[] = [];
  try {
    if (SHOWCASE_CLERK_USER_ID) {
      exampleSplats = await getExampleSplats(SHOWCASE_CLERK_USER_ID);
    }
  } catch (err) {
    console.error("Couldn't load the sitemap's examples", err);
  }

  return [
    { url: new URL("/", APP_PUBLIC_URL).toString() },
    ...exampleSplats.map(splat => ({ url: new URL(`/preview/splats/${splat.id}`, APP_PUBLIC_URL).toString() })),
  ];
}
