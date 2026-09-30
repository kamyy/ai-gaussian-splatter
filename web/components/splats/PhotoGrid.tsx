/**
 * The grid of a splat's photos on its page.
 *
 * Shows the photos in justified rows (each row stretched to fill the width, keeping every photo's shape), a few rows
 * per page. Picking a photo selects its camera in the 3D viewer, and hovering one highlights it there. A photo the
 * pointer rests on is enlarged over its neighbours, so its detail can be made out. A photo COLMAP (the
 * structure-from-motion tool in worker/) couldn't place in 3D is faded with a dashed outline and can't be picked. Arrow
 * keys move between photos.
 */

"use client";

import { useEffect, useMemo, useRef } from "react";

import { PhotoPlaceholderIcon } from "@/components/ui/icons";
import { Pager } from "@/components/ui/Pager";
import { cn } from "@/lib/cn";
import { useHoverIntent } from "@/lib/hooks/useHoverIntent";
import { useJustifiedPages } from "@/lib/hooks/useJustifiedPages";
import type { PublicPhoto } from "@/lib/types";
import type { PhotoSelection } from "./photoSelection";

// A page is this many whole rows, so every page but the last ends on a full row.
const ROWS_PER_PAGE = 3;
const ROW_HEIGHT_REM = 6;
// Matches the list's gap-1.5.
const GAP_REM = 0.375;
// How much larger a photo is drawn while the pointer rests on it. A thumbnail's long side is THUMBNAIL_LONG_SIDE pixels
// (web/lib/measurePhoto.ts), which stays sharp at this size on a high-density screen.
const EXPAND_SCALE = 2.5;
// How long the pointer rests on a photo before it enlarges.
const EXPAND_DELAY_MS = 400;

interface PhotoGridProps {
  // The grid shows only thumbnails, so both the owner's photos and the share page's public ones fit.
  photos: PublicPhoto[];
  // The photos COLMAP placed, once the cameras are known. Every other photo is flagged as unused. Null means unknown,
  // which flags nothing.
  placedPhotoIds: Set<string> | null;
  // The photo whose camera the 3D view is showing. The grid turns to its page on every new pick, even of the photo
  // already selected.
  selection: PhotoSelection | null;
  // Offered only for placed photos, since only they have a camera to show.
  onSelect: (photoId: string) => void;
  // The photo to mark as hovered, whether the pointer is over its tile or over its camera in the 3D view.
  hoveredPhotoId: string | null;
  // Reports the placed photo under the pointer, or null once the pointer leaves it.
  onHover: (photoId: string | null) => void;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The box an enlarged photo is drawn in, measured from its tile's top-left corner. tile is measured from the area's.
 *
 * The photo grows from its tile's center, then is moved to stay inside the area, because the column the grid sits in
 * clips whatever leaves it. A photo taller than the area is lined up with the area's bottom edge and runs over the
 * top, where there is always other content for it to cover. It grows by less than EXPAND_SCALE when it would
 * otherwise be wider than the area.
 */
export function expandedBox(tile: Box, area: { width: number; height: number }): Box {
  const scale = Math.min(EXPAND_SCALE, area.width / tile.width);
  const width = tile.width * scale;
  const height = tile.height * scale;
  const left = Math.min(Math.max(tile.left + (tile.width - width) / 2, 0), area.width - width);
  const top = Math.min(Math.max(tile.top + (tile.height - height) / 2, 0), area.height - height);

  return { left: left - tile.left, top: top - tile.top, width, height };
}

// A tile's box in the list's layout. offsetTop and offsetLeft ignore transforms, so a hovered tile's lift doesn't
// move it out of its row the way getBoundingClientRect would.
function layoutBox(tile: HTMLElement) {
  const item = tile.closest("li") ?? tile;
  return {
    top: item.offsetTop,
    bottom: item.offsetTop + item.offsetHeight,
    center: item.offsetLeft + item.offsetWidth / 2,
  };
}

// The photo id of the tile in the row above (-1) or below (1) whose center is nearest the one in from. Measured from
// the laid-out tiles, because justified rows don't line up in columns. null from the page's top or bottom row.
function tileInNextRow(list: HTMLElement, from: HTMLElement, direction: 1 | -1): string | null {
  const origin = layoutBox(from);
  const candidates = [...list.querySelectorAll<HTMLElement>("[data-photo-id]")]
    .map(tile => ({ id: tile.dataset.photoId ?? null, box: layoutBox(tile) }))
    .filter(({ box }) => (direction === 1 ? box.top >= origin.bottom : box.bottom <= origin.top));
  if (candidates.length === 0) {
    return null;
  }

  // The adjacent row is the candidates' topmost row going down, and their bottommost going up.
  const tops = candidates.map(({ box }) => box.top);
  const rowTop = direction === 1 ? Math.min(...tops) : Math.max(...tops);
  const row = candidates.filter(({ box }) => box.top === rowTop);
  const distance = (box: ReturnType<typeof layoutBox>) => Math.abs(box.center - origin.center);

  return row.reduce((best, tile) => (distance(tile.box) < distance(best.box) ? tile : best)).id;
}

// The same pip the pager puts on the page holding the selection, straddling the photo's corner. It hangs over the tile
// by the width of the gap between tiles, which is as far as it can go before the next tile covers it.
function SelectedMark() {
  return (
    <span
      aria-hidden="true"
      className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full border-2 border-background bg-primary"
    />
  );
}

function PhotoTile({
  photo,
  width,
  height,
  placed,
  unplaced,
  selected,
  hovered,
  enlargedBox,
  tabbable,
  onSelect,
  onPointerEnter,
  onPointerLeave,
}: {
  photo: PublicPhoto;
  width: number;
  height: number;
  // Both are false while the cameras are still unknown.
  placed: boolean;
  unplaced: boolean;
  selected: boolean;
  hovered: boolean;
  // Where to draw the photo while it is enlarged, measured from the tile's top-left corner. Null draws it in the tile.
  enlargedBox: Box | null;
  // Whether this tile is the grid's one stop in the tab order.
  tabbable: boolean;
  onSelect: () => void;
  onPointerEnter: (event: React.PointerEvent) => void;
  onPointerLeave: () => void;
}) {
  const enlarged = enlargedBox !== null;

  let unplacedMark: React.ReactNode = null;
  if (unplaced) {
    // Drawn over the photo, which would cover a border on the tile itself, and so that it grows with the photo.
    unplacedMark = (
      <span aria-hidden="true" className="absolute inset-0 rounded-md border-2 border-error border-dashed" />
    );
  }

  // The photo sits in a box of its own, which grows over the neighbouring tiles while the tile keeps its place in the
  // row. The box ignores the pointer, so the pointer moves on to a neighbour the enlarged photo is covering.
  const image = (
    <span
      style={enlargedBox ?? { left: 0, top: 0, width, height }}
      className={cn(
        "pointer-events-none absolute rounded-md transition-[left,top,width,height,box-shadow] ease-out motion-reduce:transition-none",
        enlarged && "shadow-[0_0.75rem_1.75rem_var(--raised-shade)]",
      )}
    >
      {/* biome-ignore lint/performance/noImgElement: presigned S3 URL has no fixed domain for next/image. */}
      <img
        src={photo.thumbnailUrl}
        alt={unplaced ? `${photo.originalFilename} (couldn't be placed)` : photo.originalFilename}
        loading="lazy"
        draggable={false}
        className="h-full w-full rounded-md object-cover"
      />
      {unplacedMark}
      {selected ? <SelectedMark /> : null}
    </span>
  );

  // Only a placed photo is a button, since only it has a camera to show.
  let content: React.ReactNode = image;
  if (placed) {
    content = (
      <button
        type="button"
        aria-pressed={selected}
        data-photo-id={photo.id}
        tabIndex={tabbable ? 0 : -1}
        onClick={onSelect}
        className="relative block h-full w-full cursor-pointer rounded-md focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground"
      >
        {image}
      </button>
    );
  }

  return (
    <li
      style={{ width, height }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      className={cn(
        // Not overflow-hidden, so the enlarged photo and the selection pip can leave the tile. The photo rounds its own
        // corners instead.
        "relative z-0 shrink-0 rounded-md bg-muted transition-[translate,box-shadow,opacity,z-index] [transition-duration:150ms,150ms,150ms,0s]",
        unplaced && !enlarged && "opacity-55",
        // Lifted off the grid. z-1 draws its shadow over the tiles after it, which would otherwise cover it.
        hovered && !enlarged && "z-1 -translate-y-0.5 shadow-[0_0.375rem_0.875rem_var(--raised-shade)]",
        // Drawn over every other tile. The tile drops back only once its photo has finished shrinking, or the tiles
        // after it would cut into the photo on its way down.
        enlarged ? "z-2" : "[transition-delay:0s,0s,0s,150ms]",
      )}
    >
      {/* Shows until the photo loads and covers it. The photo's box is positioned, so it paints above this icon. */}
      <PhotoPlaceholderIcon
        aria-hidden="true"
        strokeWidth={1}
        className="absolute inset-0 m-auto h-5 w-5 text-muted-foreground"
      />
      {content}
    </li>
  );
}

export function PhotoGrid({ photos, placedPhotoIds, selection, onSelect, hoveredPhotoId, onHover }: PhotoGridProps) {
  const selectedPhotoId = selection?.photoId ?? null;
  const isPlaced = (photo: PublicPhoto) => placedPhotoIds?.has(photo.id) ?? false;
  const isUnplaced = (photo: PublicPhoto) => placedPhotoIds !== null && !placedPhotoIds.has(photo.id);

  // photos arrives oldest taken first (web/app/api/v1/splats/[splatId]/photos/route.ts), and the grid keeps that order.
  // A photo with no recorded size lays out square.
  const aspects = useMemo(
    () => photos.map(photo => (photo.width !== null && photo.height !== null ? photo.width / photo.height : 1)),
    [photos],
  );
  const { setArea, areaWidth, areaHeight, current, pageCount, setPage, pageOf, start, end, tiles } = useJustifiedPages(
    aspects,
    {
      rowHeightRem: ROW_HEIGHT_REM,
      columnGapRem: GAP_REM,
      rowGapRem: GAP_REM,
      rowsPerPage: ROWS_PER_PAGE,
    },
  );

  const shownPhotos = tiles.map(tile => photos[tile.index]);
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

  // The photo whose tile the pointer is resting on, if any. React fires no pointerleave for a tile removed from under
  // the pointer, as a page turn does, so a hover the grid reported is cleared once its tile is gone. A hover that came
  // from the 3D view is left alone, even for a photo on another page.
  const gridHoverRef = useRef<string | null>(null);
  useEffect(() => {
    const id = gridHoverRef.current;
    if (id !== null && !shownPhotos.some(photo => photo.id === id)) {
      gridHoverRef.current = null;
      onHover(null);
    }
  });

  // The photo the pointer has rested on, which is drawn enlarged. Cleared like the hover above when a page turn takes
  // its tile away.
  const { settled: enlargedPhotoId, begin: beginEnlarge, end: endEnlarge } = useHoverIntent<string>(EXPAND_DELAY_MS);
  useEffect(() => {
    if (enlargedPhotoId !== null && !shownPhotos.some(photo => photo.id === enlargedPhotoId)) {
      endEnlarge();
    }
  });

  // Keyboard support. The arrow keys and Home/End select a neighbouring placed photo, turning the page when they cross
  // one. Only one tile is in the tab order, so Tab moves past the grid in one step rather than through every photo.
  const listRef = useRef<HTMLUListElement>(null);
  const placedIds = photos.filter(isPlaced).map(photo => photo.id);
  const shownPlaced = shownPhotos.filter(isPlaced);
  const tabbableId = shownPlaced.some(photo => photo.id === selectedPhotoId) ? selectedPhotoId : shownPlaced[0]?.id;

  // A photo picked from the keyboard is focused once its tile renders, which is after the page turn when there is one.
  const pendingFocusRef = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingFocusRef.current;
    const tile = id ? listRef.current?.querySelector<HTMLButtonElement>(`[data-photo-id="${id}"]`) : null;
    if (tile) {
      pendingFocusRef.current = null;
      tile.focus();
    }
  });

  function handleKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    const from = event.target as HTMLElement;
    const position = placedIds.indexOf(from.dataset.photoId ?? "");
    if (position === -1 || !listRef.current) {
      return;
    }

    let target: string | null | undefined;
    switch (event.key) {
      case "ArrowRight":
        target = placedIds[position + 1];
        break;
      case "ArrowLeft":
        target = placedIds[position - 1];
        break;
      case "ArrowDown":
        target = tileInNextRow(listRef.current, from, 1);
        break;
      case "ArrowUp":
        target = tileInNextRow(listRef.current, from, -1);
        break;
      case "Home":
        target = placedIds[0];
        break;
      case "End":
        target = placedIds[placedIds.length - 1];
        break;
      default:
        return;
    }

    event.preventDefault();
    if (target && target !== from.dataset.photoId) {
      pendingFocusRef.current = target;
      onSelect(target);
    }
  }

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
        <ul ref={listRef} onKeyDown={handleKeyDown} className="flex flex-wrap gap-1.5">
          {tiles.map(({ index, left, top, width, height }) => {
            const photo = photos[index];
            const enlargedBox =
              photo.id === enlargedPhotoId
                ? expandedBox({ left, top, width, height }, { width: areaWidth, height: areaHeight })
                : null;

            return (
              <PhotoTile
                key={photo.id}
                photo={photo}
                width={width}
                height={height}
                placed={isPlaced(photo)}
                unplaced={isUnplaced(photo)}
                selected={photo.id === selectedPhotoId}
                hovered={photo.id === hoveredPhotoId}
                enlargedBox={enlargedBox}
                tabbable={photo.id === tabbableId}
                onSelect={() => onSelect(photo.id)}
                onPointerEnter={event => {
                  // Only a placed photo has a camera for the 3D view to mark.
                  if (isPlaced(photo)) {
                    gridHoverRef.current = photo.id;
                    onHover(photo.id);
                  }

                  // A touch has no resting pointer, and its tap is a pick.
                  if (event.pointerType !== "touch") {
                    beginEnlarge(photo.id);
                  }
                }}
                onPointerLeave={() => {
                  if (isPlaced(photo)) {
                    gridHoverRef.current = null;
                    onHover(null);
                  }

                  endEnlarge();
                }}
              />
            );
          })}
        </ul>
      </div>
      {pager}
    </section>
  );
}
