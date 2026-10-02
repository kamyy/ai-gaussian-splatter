/**
 * Photo picking for the new-splat form.
 *
 * Holds the photos a visitor drops onto web/components/splats/NewSplatForm.tsx before they are uploaded. Each photo is
 * measured as it's added (pixel size, a small JPEG thumbnail, when it was taken, and how sharp it is), because the
 * server stores that size so web/components/splats/PhotoGrid.tsx can lay out its rows before any image loads. A file of
 * a type COLMAP can't read, over the server's size limit, or one this browser can't decode, is turned away with a
 * snackbar (a toast message) instead of failing halfway through an upload. A blurry or low-resolution photo is only flagged, since the visitor may
 * have no better shot of that angle.
 */

import { useState } from "react";

import { useAppSnackbar } from "@/lib/hooks/useAppSnackbar";
import { MAX_PHOTO_BYTES, MIN_SHARP_PHOTO_EDGE, PHOTO_EXTENSIONS } from "@/lib/limits";
import { fileKey, measurePhotos, type PickedPhoto } from "@/lib/measurePhoto";

const MAX_PHOTO_MB = MAX_PHOTO_BYTES / (1024 * 1024);

// A photo scoring under this fraction of the batch's median sharpness is flagged as blurry. The score is compared
// within the batch because its absolute value depends mostly on how much texture the object has.
const BLURRY_FRACTION_OF_MEDIAN = 0.35;
// Below this many photos the median says too little about how sharp this capture's photos normally are.
const MIN_PHOTOS_TO_JUDGE_BLUR = 8;

export type PhotoFlag = "blurry" | "low_res";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Keyed by fileKey. A photo that is both low resolution and blurry is flagged as low resolution. */
export function findFlagged(photos: PickedPhoto[]): Map<string, PhotoFlag> {
  const flagged = new Map<string, PhotoFlag>();
  const blurLimit =
    photos.length >= MIN_PHOTOS_TO_JUDGE_BLUR
      ? median(photos.map(photo => photo.sharpness)) * BLURRY_FRACTION_OF_MEDIAN
      : null;

  for (const photo of photos) {
    if (Math.max(photo.width, photo.height) < MIN_SHARP_PHOTO_EDGE) {
      flagged.set(fileKey(photo.file), "low_res");
    } else if (blurLimit !== null && photo.sharpness < blurLimit) {
      flagged.set(fileKey(photo.file), "blurry");
    }
  }

  return flagged;
}

/**
 * The photos come back oldest taken first, with each file at most once. measuring is set while any added batch is still
 * being measured. Submitting waits for it, or those photos would be left out of the upload. flagged marks each blurry or
 * low-resolution photo.
 */
export function usePickedPhotos() {
  const { enqueueSnackbar } = useAppSnackbar();
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [measuringCount, setMeasuringCount] = useState(0);

  // Resolves once the batch is measured and added.
  async function addFiles(dropped: File[]) {
    const unsupported = dropped.filter(file => !Object.hasOwn(PHOTO_EXTENSIONS, file.type)).map(file => file.name);
    if (unsupported.length > 0) {
      enqueueSnackbar(unsupported.length === 1 ? "Unsupported photo" : "Unsupported photos", {
        variant: "error",
        detail: `Only JPEG and PNG photos can be used. Try exporting ${unsupported.join(", ")} as JPEG.`,
      });
    }

    const supported = dropped.filter(file => Object.hasOwn(PHOTO_EXTENSIONS, file.type));
    const tooLarge = supported.filter(file => file.size > MAX_PHOTO_BYTES).map(file => file.name);
    if (tooLarge.length > 0) {
      enqueueSnackbar(tooLarge.length === 1 ? "Photo too large" : "Photos too large", {
        variant: "error",
        detail: `${tooLarge.join(", ")} ${tooLarge.length === 1 ? "is" : "are"} over ${MAX_PHOTO_MB} MB.`,
      });
    }

    const accepted = supported.filter(file => file.size <= MAX_PHOTO_BYTES);
    setMeasuringCount(count => count + 1);
    try {
      const measured = await measurePhotos(accepted);
      const unreadable = accepted.filter((_, index) => measured[index] === null).map(file => file.name);
      if (unreadable.length > 0) {
        enqueueSnackbar(unreadable.length === 1 ? "Couldn't read photo" : "Couldn't read photos", {
          variant: "error",
          detail: `Try exporting ${unreadable.join(", ")} as JPEG.`,
        });
      }

      const readable = measured.filter(photo => photo !== null);
      setPhotos(current => {
        const seen = new Set(current.map(photo => fileKey(photo.file)));

        // Oldest taken first, matching the order the splat's page shows them in. The sort is stable, so photos taken at
        // the same moment keep the order they were added in.
        return [...current, ...readable.filter(photo => !seen.has(fileKey(photo.file)))].sort(
          (a, b) => a.takenAt - b.takenAt,
        );
      });
    } finally {
      setMeasuringCount(count => count - 1);
    }
  }

  function removeFiles(keys: string[]) {
    setPhotos(current => current.filter(photo => !keys.includes(fileKey(photo.file))));
  }

  return { photos, flagged: findFlagged(photos), measuring: measuringCount > 0, addFiles, removeFiles };
}
