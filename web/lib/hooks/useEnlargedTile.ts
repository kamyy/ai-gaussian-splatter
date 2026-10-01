/**
 * Tracks which photo tile is drawn enlarged, for a paged grid of photos.
 *
 * The splat page's photo grid and the new-splat form's previews both enlarge the photo the pointer rests on, drawn by
 * web/components/splats/EnlargingPhotoBox.tsx. This hook decides which photo that is. React fires no pointerleave for a
 * tile removed from under the pointer, as a page turn or a removed photo does, so the enlargement is also cleared once
 * its tile is no longer shown.
 */

import { useEffect } from "react";

import { useHoverIntent } from "./useHoverIntent";

// How long the pointer rests on a photo before it enlarges.
const ENLARGE_DELAY_MS = 400;

/**
 * shownIds are the ids of the tiles on the current page. Call enter from a tile's pointerenter and leave from its
 * pointerleave. enlargedId is the tile drawn enlarged, or null.
 */
export function useEnlargedTile(shownIds: string[]) {
  const { settled: enlargedId, begin, end } = useHoverIntent<string>(ENLARGE_DELAY_MS);

  useEffect(() => {
    if (enlargedId !== null && !shownIds.includes(enlargedId)) {
      end();
    }
  });

  function enter(id: string, event: React.PointerEvent) {
    // A touch has no resting pointer, and its tap is a pick.
    if (event.pointerType !== "touch") {
      begin(id);
    }
  }

  return { enlargedId, enter, leave: end };
}
