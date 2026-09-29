import { useState } from "react";

import { useAppSnackbar } from "@/lib/hooks/useAppSnackbar";
import { MAX_PHOTO_BYTES } from "@/lib/limits";
import { fileKey, measurePhotos, type PickedPhoto } from "@/lib/measurePhoto";

const MAX_PHOTO_MB = MAX_PHOTO_BYTES / (1024 * 1024);

/**
 * The photos picked for a new splat, oldest taken first, with each file picked at most once. Each photo is measured as
 * it's added, because the server stores its size for web/components/splats/PhotoGrid.tsx. A photo too large for the
 * server, or one this browser can't decode, is turned away with a snackbar rather than failing mid-upload.
 *
 * measuring is set while any added batch is still being measured. Submitting waits for it, or those photos would be
 * left out of the upload.
 */
export function usePickedPhotos() {
  const { enqueueSnackbar } = useAppSnackbar();
  const [photos, setPhotos] = useState<PickedPhoto[]>([]);
  const [measuringCount, setMeasuringCount] = useState(0);

  // Resolves once the batch is measured and added.
  async function addFiles(dropped: File[]) {
    const tooLarge = dropped.filter(file => file.size > MAX_PHOTO_BYTES).map(file => file.name);
    if (tooLarge.length > 0) {
      enqueueSnackbar(`${tooLarge.join(", ")} ${tooLarge.length === 1 ? "is" : "are"} over ${MAX_PHOTO_MB} MB.`, {
        variant: "error",
      });
    }
    const accepted = dropped.filter(file => file.size <= MAX_PHOTO_BYTES);
    setMeasuringCount(count => count + 1);
    try {
      const measured = await measurePhotos(accepted);
      const unreadable = accepted.filter((_, index) => measured[index] === null).map(file => file.name);
      if (unreadable.length > 0) {
        enqueueSnackbar(`Couldn't read ${unreadable.join(", ")}. Try exporting as JPEG.`, { variant: "error" });
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

  function removeFile(key: string) {
    setPhotos(current => current.filter(photo => fileKey(photo.file) !== key));
  }

  return { photos, measuring: measuringCount > 0, addFiles, removeFile };
}
