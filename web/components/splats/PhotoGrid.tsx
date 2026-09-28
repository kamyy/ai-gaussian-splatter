"use client";

import { useEffect, useMemo, useRef } from "react";
import { LuImage } from "react-icons/lu";

import { Pager } from "@/components/ui/Pager";
import { cn } from "@/lib/cn";
import type { PhotoListItem } from "@/lib/types";
import { useJustifiedPages } from "@/lib/useJustifiedPages";
import type { PhotoSelection } from "./photoSelection";

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
  // The photo whose camera the 3D view is showing. The grid turns to its page on every new pick, even of the photo
  // already selected.
  selection: PhotoSelection | null;
  // Offered only for placed photos, since only they have a camera to show.
  onSelect: (photoId: string) => void;
}

// Drawn over the photo, which would cover a tint or border on the tile itself.
function SelectedMark() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rounded-md border-2 border-primary bg-primary/30"
    />
  );
}

export function PhotoGrid({ photos, placedPhotoIds, selection, onSelect }: PhotoGridProps) {
  const selectedPhotoId = selection?.photoId ?? null;
  const isUnplaced = (photo: PhotoListItem) => placedPhotoIds !== null && !placedPhotoIds.has(photo.id);
  // photos arrives oldest taken first (web/app/api/v1/splats/[splatId]/photos/route.ts), and the grid keeps that order.
  // A photo with no recorded size lays out square.
  const aspects = useMemo(
    () => photos.map(photo => (photo.width !== null && photo.height !== null ? photo.width / photo.height : 1)),
    [photos],
  );
  const { setArea, areaHeight, current, pageCount, setPage, pageOf, start, end, tiles } = useJustifiedPages(aspects, {
    rowHeightRem: ROW_HEIGHT_REM,
    columnGapRem: GAP_REM,
    rowGapRem: GAP_REM,
    rowsPerPage: ROWS_PER_PAGE,
  });
  const unplacedCount = photos.filter(isUnplaced).length;

  const selectedIndex = photos.findIndex(photo => photo.id === selectedPhotoId);
  const selectedPage = selectedIndex === -1 ? 0 : pageOf(selectedIndex);
  // Turns once per pick, so paging away from the selection by hand stays put until the next one. A pick made before the
  // grid has been measured has no page yet, and turns once it does.
  const turnedForRef = useRef<PhotoSelection | null>(null);
  useEffect(() => {
    if (selection === turnedForRef.current || selectedPage === 0) {
      return;
    }
    turnedForRef.current = selection;
    setPage(selectedPage);
  }, [selection, selectedPage, setPage]);

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
    pager = (
      <Pager
        label="Photo pages"
        current={current}
        count={pageCount}
        onChange={setPage}
        markedPage={selectedPage > 0 ? selectedPage : null}
      />
    );
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
            const unplaced = isUnplaced(photo);
            const image = (
              // biome-ignore lint/performance/noImgElement: presigned S3 URL has no fixed domain for next/image.
              <img
                src={photo.thumbnailUrl}
                alt={unplaced ? `${photo.originalFilename} (couldn't be placed)` : photo.originalFilename}
                loading="lazy"
                draggable={false}
                className="relative h-full w-full object-cover"
              />
            );
            const selected = photo.id === selectedPhotoId;
            let content: React.ReactNode = image;
            if (placedPhotoIds?.has(photo.id)) {
              content = (
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onSelect(photo.id)}
                  className="relative block h-full w-full cursor-pointer rounded-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground"
                >
                  {image}
                  {selected ? <SelectedMark /> : null}
                </button>
              );
            }
            return (
              <li
                key={photo.id}
                style={{ width: tile.width, height: tile.height }}
                className={cn(
                  "relative shrink-0 overflow-hidden rounded-md bg-muted",
                  unplaced && "outline-2 outline-error outline-dashed -outline-offset-2",
                  unplaced && "opacity-55",
                )}
              >
                {/* Shows until the photo loads and covers it. The photo is relative so it paints above this icon. */}
                <LuImage
                  aria-hidden="true"
                  strokeWidth={1}
                  className="absolute inset-0 m-auto h-5 w-5 text-muted-foreground"
                />
                {content}
              </li>
            );
          })}
        </ul>
      </div>
      {pager}
    </section>
  );
}
