/**
 * Uploads a new splat's photos.
 *
 * For each batch it asks the API for presigned URLs (time-limited links that let the browser upload straight to S3,
 * AWS's file storage), uploads each photo and its thumbnail to them, and then tells the API each photo is complete.
 * web/components/splats/NewSplatForm.tsx calls it right after creating a splat, which is the only place photos can be
 * added.
 */

import { apiFetch } from "./apiFetch";
import type { PickedPhoto } from "./measurePhoto";
import type { PhotoPresignItem } from "./types";

/** onUploaded fires once per photo the server has marked uploaded, so the caller can leave it out of a retry. */
export async function uploadPhotos(
  splatId: string,
  photos: PickedPhoto[],
  token: string,
  onUploaded: (photo: PickedPhoto) => void,
): Promise<void> {
  // A retry whose failed photos were all removed has nothing left to send, and the presign route rejects an empty
  // batch.
  if (photos.length === 0) {
    return;
  }

  const presigned = await apiFetch<PhotoPresignItem[]>(
    `/api/v1/splats/${splatId}/photos/presign`,
    "POST",
    token,
    photos.map(({ file, thumbnail, width, height, takenAt }) => ({
      filename: file.name,
      contentType: file.type || "image/jpeg",
      size: file.size,
      thumbnailSize: thumbnail.size,
      width,
      height,
      takenAt: new Date(takenAt).toISOString(),
    })),
  );

  const results = await Promise.all(
    photos.map(async (photo, index) => {
      const { file, thumbnail } = photo;
      const item = presigned[index];
      try {
        // Both land before the photo is marked uploaded, so an uploaded photo always has its thumbnail.
        const responses = await Promise.all([
          fetch(item.presignedPutUrl, { headers: { "Content-Type": file.type }, method: "PUT", body: file }),
          fetch(item.thumbnailPutUrl, { headers: { "Content-Type": "image/jpeg" }, method: "PUT", body: thumbnail }),
        ]);
        const failed = responses.find(response => !response.ok);
        if (failed !== undefined) {
          throw new Error(`S3 upload failed: ${failed.statusText}`);
        }

        await apiFetch<void>(`/api/v1/splats/${splatId}/photos/${item.photoId}/complete`, "POST", token);
        onUploaded(photo);
        return true;
      } catch {
        return false;
      }
    }),
  );

  // A failed photo never reaches onUploaded, so the caller's retry sends it again. This throw is what tells
  // web/components/splats/NewSplatForm.tsx that at least one upload failed, so it doesn't treat a failed batch as a
  // success.
  const failedCount = results.filter(ok => !ok).length;
  if (failedCount > 0) {
    throw new Error(`${failedCount} of ${photos.length} photo upload${photos.length === 1 ? "" : "s"} failed`);
  }
}
