"use client";

import { useState } from "react";

import type { PhotoListItem } from "@/lib/types";

// How many photos show before "See all". Two rows of the grid below.
const COLLAPSED_COUNT = 16;

export function PhotoGrid({ photos }: { photos: PhotoListItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? photos : photos.slice(0, COLLAPSED_COUNT);

  return (
    <section aria-labelledby="photos-heading" className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <h2 id="photos-heading" className="text-sm font-semibold">
          {photos.length} photo{photos.length === 1 ? "" : "s"}
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
          <li key={photo.id} className="aspect-square overflow-hidden rounded-md bg-muted">
            {/* biome-ignore lint/performance/noImgElement: presigned S3 URL has no fixed domain for next/image. */}
            <img
              src={photo.url}
              alt={photo.originalFilename}
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
