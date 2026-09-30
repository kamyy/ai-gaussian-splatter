/**
 * The /splats page: the signed-in user's library of splats.
 *
 * Lists every splat as a card, filterable by what it needs next, and pages them in whole rows sized to each cover
 * photo's shape. An empty library shows a prompt to make the first splat instead.
 */

"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { SplatCard, splatCardAspect } from "@/components/splats/SplatCard";
import { buttonClassName } from "@/components/ui/Button";
import { ThumbnailPlaceholderIcon } from "@/components/ui/icons";
import { Pager } from "@/components/ui/Pager";
import { cn } from "@/lib/cn";
import { useJustifiedPages } from "@/lib/hooks/useJustifiedPages";
import { useSplats } from "@/lib/hooks/useSplats";
import { type LibraryFilter, splatBadge } from "@/lib/splatBadge";

const FILTERS: { value: LibraryFilter | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "needs_you", label: "Needs you" },
  { value: "in_progress", label: "In progress" },
  { value: "complete", label: "Complete" },
];

// A page is this many whole rows of cards, so every page but the last ends on a full row.
const ROWS_PER_PAGE = 3;
// About the height of a card image. Each full row stretches a little past it to fill the width.
const ROW_HEIGHT_REM = 14.75;
// Match the card list's gap-x-6 and gap-y-7.
const COLUMN_GAP_REM = 1.5;
const ROW_GAP_REM = 1.75;
// The name line below each card image (web/components/splats/SplatCard.tsx): its gap-3 plus text-2xl's 2rem line.
const CAPTION_REM = 2.75;

function SplatGridSkeleton() {
  return (
    <div className="grid gap-x-6 gap-y-7 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-hidden="true">
      {[0, 1, 2, 3].map(i => (
        <div
          key={i}
          className="flex h-59 animate-pulse items-center justify-center rounded-3xl bg-muted text-muted-foreground"
        >
          <ThumbnailPlaceholderIcon strokeWidth={1} className="h-8 w-8" />
        </div>
      ))}
    </div>
  );
}

function EmptyLibrary() {
  return (
    <div className="flex flex-col items-start gap-4">
      <p className="max-w-120 text-lg text-muted-foreground">
        No splats yet. Photograph an object from every side and upload the photos to make your first one.
      </p>
      <Link href="/splats/new" className={buttonClassName("contained", "large")}>
        Make your first splat
      </Link>
    </div>
  );
}

export default function LibraryPage() {
  const { data: splats, isLoading, error } = useSplats();

  const [filter, setFilter] = useState<LibraryFilter | "all">("all");
  const filtered = useMemo(
    () => (filter === "all" ? (splats ?? []) : (splats ?? []).filter(splat => splatBadge(splat).filter === filter)),
    [splats, filter],
  );

  const aspects = useMemo(() => filtered.map(splatCardAspect), [filtered]);
  const { setArea, areaHeight, current, pageCount, setPage, tiles } = useJustifiedPages(aspects, {
    rowHeightRem: ROW_HEIGHT_REM,
    columnGapRem: COLUMN_GAP_REM,
    rowGapRem: ROW_GAP_REM,
    rowsPerPage: ROWS_PER_PAGE,
    captionRem: CAPTION_REM,
  });

  let body: React.ReactNode;
  if (isLoading) {
    body = <SplatGridSkeleton />;
  } else if (error || !splats) {
    body = <p className="text-error">Failed to load splats.</p>;
  } else if (splats.length === 0) {
    body = <EmptyLibrary />;
  } else if (filtered.length === 0) {
    body = <p className="text-muted-foreground">Nothing here right now.</p>;
  } else {
    let pager: React.ReactNode = null;
    if (pageCount > 1) {
      pager = <Pager label="Library pages" current={current} count={pageCount} onChange={setPage} />;
    }

    body = (
      <div className="flex flex-col gap-8">
        {/* Measured for its width, which decides how many cards each row holds. It keeps the tallest page's height, so
        the pager below stays put from page to page. */}
        <div ref={setArea} style={{ minHeight: areaHeight }}>
          <ul className="flex flex-wrap gap-x-6 gap-y-7">
            {tiles.map(tile => {
              const splat = filtered[tile.index];
              return (
                <li key={splat.id} style={{ width: tile.width }} className="shrink-0">
                  <SplatCard splat={splat} />
                </li>
              );
            })}
          </ul>
        </div>
        {pager}
      </div>
    );
  }

  let filters: React.ReactNode = null;
  if (splats && splats.length > 0) {
    filters = (
      // Buttons with aria-pressed rather than a tablist: each option re-filters one list, there are no separate tab
      // panels for a tablist to point at.
      <fieldset className="flex max-w-full gap-0.5 overflow-x-auto rounded-full border border-divider bg-paper p-1">
        <legend className="sr-only">Filter</legend>
        {FILTERS.map(option => (
          <button
            key={option.value}
            type="button"
            aria-pressed={filter === option.value}
            onClick={() => {
              setFilter(option.value);
              setPage(1);
            }}
            className={cn(
              "h-9 rounded-full px-3 text-sm font-semibold whitespace-nowrap sm:px-4",
              filter === option.value ? "bg-foreground text-background" : "hover:bg-muted",
            )}
          >
            {option.label}
          </button>
        ))}
      </fieldset>
    );
  }

  return (
    <div className="flex flex-col gap-8 px-4 py-10 sm:px-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="font-display text-5xl tracking-tight sm:text-6xl">
          Your splats{" "}
          {splats && splats.length > 0 ? <span className="ml-2 text-muted-foreground">{splats.length}</span> : null}
        </h1>
        {filters}
      </div>
      {body}
    </div>
  );
}
