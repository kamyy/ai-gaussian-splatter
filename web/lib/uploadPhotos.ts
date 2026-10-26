/**
 * Uploads a new splat's photos.
 *
 * It reserves the batch with the API, which creates a row for each photo. Then, a few photos at a time, it asks for
 * each photo's presigned URLs (time-limited links that let the browser upload straight to S3, AWS's file storage),
 * uploads the photo and its thumbnail to them, and tells the API the photo is complete. Asking just before each upload
 * keeps a long batch from outlasting its links. web/components/splats/NewSplatForm.tsx calls it right after creating
 * a splat, which is the only place photos can be added.
 */

import { apiFetch } from "./apiFetch";
import type { PickedPhoto } from "./measurePhoto";
import { requireToken } from "./requireToken";
import type { PhotoReservation, PhotoUploadUrls } from "./types";

// Each photo is two PUTs to the same S3 host, and a browser opens about 6 connections per host. With three photos at a
// time, every PUT starts as soon as its link is signed instead of queueing behind the others.
const PHOTOS_IN_FLIGHT = 3;

// Resolves to whether the photo was uploaded. A missing Clerk session is thrown instead, since retrying the photo
// can't fix it.
async function uploadPhoto(
  splatId: string,
  photo: PickedPhoto,
  photoId: string,
  getToken: () => Promise<string | null>,
): Promise<boolean> {
  const { file, thumbnail } = photo;

  const presignToken = await requireToken(getToken);
  try {
    const urls = await apiFetch<PhotoUploadUrls>(
      `/api/v1/splats/${splatId}/photos/${photoId}/presign`,
      "POST",
      presignToken,
      { thumbnailSize: thumbnail.size },
    );

    // Both land before the photo is marked uploaded, so an uploaded photo always has its thumbnail.
    const responses = await Promise.all([
      fetch(urls.photoPutUrl, { headers: { "Content-Type": file.type }, method: "PUT", body: file }),
      fetch(urls.thumbnailPutUrl, { headers: { "Content-Type": "image/jpeg" }, method: "PUT", body: thumbnail }),
    ]);
    if (responses.some(response => !response.ok)) {
      return false;
    }
  } catch {
    return false;
  }

  const completeToken = await requireToken(getToken);
  try {
    await apiFetch<void>(`/api/v1/splats/${splatId}/photos/${photoId}/complete`, "POST", completeToken);
  } catch {
    return false;
  }

  return true;
}

/**
 * onUploaded fires once per photo the server has marked uploaded, so the caller can leave it out of a retry. getToken is
 * Clerk's, called before each API request. A Clerk session token lasts 60 seconds, which a large batch's uploads
 * outlast.
 */
export async function uploadPhotos(
  splatId: string,
  photos: PickedPhoto[],
  getToken: () => Promise<string | null>,
  onUploaded: (photo: PickedPhoto) => void,
): Promise<void> {
  // A retry whose failed photos were all removed has nothing left to send, and the reserve route rejects an empty
  // batch.
  if (photos.length === 0) {
    return;
  }

  const reservations = await apiFetch<PhotoReservation[]>(
    `/api/v1/splats/${splatId}/photos/reserve`,
    "POST",
    await requireToken(getToken),
    photos.map(({ file, width, height, takenAt }) => ({
      filename: file.name,
      contentType: file.type || "image/jpeg",
      size: file.size,
      width,
      height,
      takenAt: new Date(takenAt).toISOString(),
    })),
  );

  // Each lane takes the next photo once its last one finishes.
  let failedCount = 0;
  let next = 0;
  async function runLane() {
    while (next < photos.length) {
      const index = next;
      next += 1;
      if (await uploadPhoto(splatId, photos[index], reservations[index].photoId, getToken)) {
        onUploaded(photos[index]);
      } else {
        failedCount += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PHOTOS_IN_FLIGHT, photos.length) }, runLane));

  // A failed photo never reaches onUploaded, so the caller's retry sends it again. This throw is what tells
  // web/components/splats/NewSplatForm.tsx that at least one upload failed, so it doesn't treat a failed batch as a
  // success.
  if (failedCount > 0) {
    throw new Error(`${failedCount} of ${photos.length} photo upload${photos.length === 1 ? "" : "s"} failed`);
  }
}
