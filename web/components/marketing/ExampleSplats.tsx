/**
 * The examples on the / landing page: finished splats anyone can open without signing in.
 *
 * Lays the cards out in justified rows the way the /splats library does, with each card opening the splat's share page
 * at /preview/splats/[id]. The landing page reads the list on the server and hands it in. This is a separate client
 * component because the row layout measures the page's width in the browser.
 */

"use client";

import { useMemo } from "react";

import { SPLAT_CARD_ROWS, SplatCard, splatCardAspect } from "@/components/splats/SplatCard";
import { useJustifiedPages } from "@/lib/hooks/useJustifiedPages";
import type { ExampleSplat } from "@/lib/types";

export function ExampleSplats({ splats }: { splats: ExampleSplat[] }) {
  const aspects = useMemo(() => splats.map(splatCardAspect), [splats]);
  // One page holding every row, since the landing page has no pager.
  const { setArea, areaHeight, tiles } = useJustifiedPages(aspects, {
    ...SPLAT_CARD_ROWS,
    rowsPerPage: Number.POSITIVE_INFINITY,
  });

  return (
    <div ref={setArea} style={{ minHeight: areaHeight }}>
      <ul className="flex flex-wrap gap-x-6 gap-y-7">
        {tiles.map(tile => {
          const splat = splats[tile.index];
          return (
            <li key={splat.id} style={{ width: tile.width }} className="shrink-0">
              <SplatCard splat={splat} href={`/preview/splats/${splat.id}`} badge={null} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
