/**
 * Which photo a splat page has picked, including the one it opens on.
 *
 * The owner's page and the public share page both open on the first photo in the grid that has a camera pose, so the
 * 3D view starts there. A photo the reconstruct stage could not place has no pose, so it is skipped. Picking another
 * photo replaces it. Moving the view by hand clears it, and the opening photo is not picked again for the rest of the
 * visit.
 */

"use client";

import { useState } from "react";

import type { PhotoSelection } from "@/lib/types";

// Undefined while the photos or the cameras are still loading. Null when they have loaded and no photo has a pose.
function openingPhotoId(
  photos: { id: string }[] | undefined,
  cameras: { photoId: string }[] | null | undefined,
): string | null | undefined {
  if (photos === undefined || cameras === undefined) {
    return undefined;
  }

  if (cameras === null) {
    return null;
  }

  const placed = new Set(cameras.map(camera => camera.photoId));

  return photos.find(photo => placed.has(photo.id))?.id ?? null;
}

/**
 * selection is the picked photo, or null when none is. selectPhoto picks one. clearSelection leaves none, which is what
 * the viewer calls once the visitor moves the view by hand.
 */
export function usePhotoSelection(
  photos: { id: string }[] | undefined,
  cameras: { photoId: string }[] | null | undefined,
) {
  const [selection, setSelection] = useState<PhotoSelection | null>(null);
  const [decided, setDecided] = useState(false);

  // Chosen while rendering so the viewer mounts on the opening photo, rather than framing the scene and then flying.
  const openingId = openingPhotoId(photos, cameras);
  if (!decided && openingId !== undefined) {
    setDecided(true);
    if (openingId !== null && selection === null) {
      setSelection({ photoId: openingId, opening: true });
    }
  }

  const selectPhoto = (photoId: string) => {
    setDecided(true);
    setSelection({ photoId });
  };

  const clearSelection = () => {
    setDecided(true);
    setSelection(null);
  };

  return { selection, selectPhoto, clearSelection };
}
