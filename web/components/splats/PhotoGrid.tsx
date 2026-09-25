"use client";

import { useState } from "react";

import { cn } from "@/lib/cn";
import type { PhotoListItem } from "@/lib/types";

// How many photos show before "See all". Two rows of the grid below.
const COLLAPSED_COUNT = 16;

interface PhotoGridProps {
  photos: PhotoListItem[];
  // The photos COLMAP placed, once the cameras are known. Every other photo is flagged as unused. Null means unknown,
  // which flags nothing.
  placedPhotoIds: Set<string> | null;
}

export function PhotoGrid({ photos, placedPhotoIds }: PhotoGridProps) {
  const [expanded, setExpanded] = useState(false);
  const isUnplaced = (photo: PhotoListItem) => placedPhotoIds !== null && !placedPhotoIds.has(photo.id);
  const unplacedCount = photos.filter(isUnplaced).length;
  // Unplaced photos lead, so they're visible without expanding the grid.
  const ordered = [...photos.filter(isUnplaced), ...photos.filter(photo => !isUnplaced(photo))];
  const shown = expanded ? ordered : ordered.slice(0, COLLAPSED_COUNT);

  return (
    <section aria-labelledby="photos-heading" className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <h2 id="photos-heading" className="text-sm font-semibold">
          {photos.length} photo{photos.length === 1 ? "" : "s"}
          {unplacedCount > 0 && (
            <span className="font-medium text-error"> · {unplacedCount} couldn&apos;t be placed</span>
          )}
        </h2>
        {photos.length > COLLAPSED_COUNT && (
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            className="text-sm font-medium text-primary hover:underline"
          >
            {expanded ? "Show fewer" : `See all ${photos.length}`}
          </button>
        )}
      </div>
      <ul className="grid grid-cols-8 gap-1.5">
        {shown.map(photo => (
          <li
            key={photo.id}
            className={cn(
              "aspect-square overflow-hidden rounded-md bg-muted",
              isUnplaced(photo) && "opacity-55 outline-2 outline-error outline-dashed -outline-offset-2",
            )}
          >
            {/* biome-ignore lint/performance/noImgElement: presigned S3 URL has no fixed domain for next/image. */}
            <img
              src={photo.url}
              alt={isUnplaced(photo) ? `${photo.originalFilename} (couldn't be placed)` : photo.originalFilename}
              loading="lazy"
              draggable={false}
              className="h-full w-full object-cover"
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
