/**
 * The examples on the / landing page: finished splats anyone can open without signing in.
 *
 * Each card opens the splat's share page at /preview/splats/[id]. The landing page reads the list on the server and
 * hands it in. From the sm breakpoint up, the cards fill one justified row the way the /splats library lays out its
 * rows, and examples that don't fit are left off. On a phone, one row holds only a card or two, so the cards sit in a
 * strip that swipes sideways instead. Both are rendered and CSS shows one, so the server's HTML already matches the
 * screen. This is a separate client component because the justified row measures the page's width in the browser.
 */

"use client";

import { useMemo } from "react";

import { SPLAT_CARD_ROWS, SplatCard, splatCardAspect } from "@/components/splats/SplatCard";
import { cn } from "@/lib/cn";
import { useJustifiedPages } from "@/lib/hooks/useJustifiedPages";
import type { ExampleSplat } from "@/lib/types";

function exampleHref(splat: ExampleSplat) {
  return `/preview/splats/${splat.id}`;
}

// One justified row, cut off after the last card that fits.
function ExampleRow({ splats, className }: { splats: ExampleSplat[]; className: string }) {
  const aspects = useMemo(() => splats.map(splatCardAspect), [splats]);
  // The first page is the first row. The examples on later pages aren't shown.
  const { setArea, areaHeight, tiles } = useJustifiedPages(aspects, { ...SPLAT_CARD_ROWS, rowsPerPage: 1 });

  return (
    <div ref={setArea} style={{ minHeight: areaHeight }} className={className}>
      <ul className="flex flex-wrap gap-x-6 gap-y-7">
        {tiles.map(tile => {
          const splat = splats[tile.index];
          return (
            <li key={splat.id} style={{ width: tile.width }} className="shrink-0">
              <SplatCard splat={splat} href={exampleHref(splat)} badge={null} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Every example in a sideways-scrolling strip of cards the same height. The strip runs out to the screen's edges, so
// the next card peeking in shows there is more to swipe to.
function ExampleStrip({ splats, className }: { splats: ExampleSplat[]; className: string }) {
  return (
    <ul className={cn("-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-x-4 overflow-x-auto px-4 pb-2", className)}>
      {splats.map(splat => (
        <li
          key={splat.id}
          style={{ width: `${splatCardAspect(splat) * SPLAT_CARD_ROWS.rowHeightRem}rem` }}
          className="shrink-0 snap-start"
        >
          <SplatCard splat={splat} href={exampleHref(splat)} badge={null} />
        </li>
      ))}
    </ul>
  );
}

export function ExampleSplats({ splats }: { splats: ExampleSplat[] }) {
  return (
    <>
      <ExampleStrip splats={splats} className="sm:hidden" />
      <ExampleRow splats={splats} className="hidden sm:block" />
    </>
  );
}
