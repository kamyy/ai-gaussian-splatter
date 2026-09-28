"use client";

import { useMemo } from "react";
import { LuImage } from "react-icons/lu";

import { Pager } from "@/components/ui/Pager";
import { cn } from "@/lib/cn";
import type { PhotoListItem } from "@/lib/types";
import { useJustifiedPages } from "@/lib/useJustifiedPages";

// A page is this many whole rows, so every page but the last ends on a full row.
const ROWS_PER_PAGE = 3;
const ROW_HEIGHT_REM = 6;
// Matches the list's gap-1.5.
const GAP_REM = 0.375;

interface PhotoGridProps {
  photos: PhotoListItem[];
  // The photos COLMAP placed, once the cameras are known. Every other photo is flagged as unused. Null means unknown,
  // which flags nothing.
  placedPhotoIds: Set<string> | null;
}

export function PhotoGrid({ photos, placedPhotoIds }: PhotoGridProps) {
  const isUnplaced = (photo: PhotoListItem) => placedPhotoIds !== null && !placedPhotoIds.has(photo.id);
  // photos arrives oldest taken first (web/app/api/v1/splats/[splatId]/photos/route.ts), and the grid keeps that order.
  // A photo with no recorded size lays out square.
  const aspects = useMemo(
    () => photos.map(photo => (photo.width !== null && photo.height !== null ? photo.width / photo.height : 1)),
    [photos],
  );
  const { setArea, areaHeight, current, pageCount, setPage, start, end, tiles } = useJustifiedPages(aspects, {
    rowHeightRem: ROW_HEIGHT_REM,
    columnGapRem: GAP_REM,
    rowGapRem: GAP_REM,
    rowsPerPage: ROWS_PER_PAGE,
  });
  const unplacedCount = photos.filter(isUnplaced).length;

  let unplacedNote: React.ReactNode = null;
  if (unplacedCount > 0) {
    unplacedNote = <span className="font-medium text-error"> · {unplacedCount} couldn&apos;t be placed</span>;
  }

  let range: React.ReactNode = null;
  let pager: React.ReactNode = null;
  if (pageCount > 1) {
    range = (
      <span className="text-sm text-muted-foreground">
        {start + 1}–{end} of {photos.length}
      </span>
    );
    pager = <Pager label="Photo pages" current={current} count={pageCount} onChange={setPage} />;
  }

  return (
    <section aria-labelledby="photos-heading" className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <h2 id="photos-heading" className="text-sm font-semibold">
          {photos.length} photo{photos.length === 1 ? "" : "s"}
          {unplacedNote}
        </h2>
        {range}
      </div>
      {/* Measured for its width, which decides how many photos each row holds. */}
      <div ref={setArea} style={{ minHeight: areaHeight }}>
        <ul className="flex flex-wrap gap-1.5">
          {tiles.map(tile => {
            const photo = photos[tile.index];
            return (
              <li
                key={photo.id}
                style={{ width: tile.width, height: tile.height }}
                className={cn(
                  "relative shrink-0 overflow-hidden rounded-md bg-muted",
                  isUnplaced(photo) && "opacity-55 outline-2 outline-error outline-dashed -outline-offset-2",
                )}
              >
                {/* Shows until the photo loads and covers it. The photo is relative so it paints above this icon. */}
                <LuImage
                  aria-hidden="true"
                  strokeWidth={1}
                  className="absolute inset-0 m-auto h-5 w-5 text-muted-foreground"
                />
                {/* biome-ignore lint/performance/noImgElement: presigned S3 URL has no fixed domain for next/image. */}
                <img
                  src={photo.thumbnailUrl}
                  alt={isUnplaced(photo) ? `${photo.originalFilename} (couldn't be placed)` : photo.originalFilename}
                  loading="lazy"
                  draggable={false}
                  className="relative h-full w-full object-cover"
                />
              </li>
            );
          })}
        </ul>
      </div>
      {pager}
    </section>
  );
}
