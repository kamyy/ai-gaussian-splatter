/**
 * Uploads a new splat's photos.
 *
 * It reserves the batch with the API, which creates a row for each photo. Then, a few photos at a time, it asks for
 * each photo's presigned URLs (time-limited links that let the browser upload straight to S3, AWS's file storage),
 * uploads the photo and its thumbnail to them, and tells the API the photo is complete. Asking just before each upload
 * keeps a long batch from outlasting its links. A retry reuses the reservations it already holds, because each reserve
 * call spends one of the caller's rate-limited upload batches. web/components/splats/NewSplatForm.tsx calls it right
 * after creating a splat, which is the only place photos can be added.
 */

import { apiFetch } from "./apiFetch";
import { fileKey, type PickedPhoto } from "./measurePhoto";
import { requireToken } from "./requireToken";
import type { PhotoReservation, PhotoUploadUrls } from "./types";

// Each photo is two PUTs to the same S3 host, and a browser opens about 6 connections per host. With three photos at a
// time, every PUT starts as soon as its link is signed instead of queueing behind the others.
const PHOTOS_IN_FLIGHT = 3;

/** What a batch has done so far, kept by the caller so a retry skips it. Photos are keyed by fileKey(). */
export interface UploadProgress {
  /** The photo id each already-reserved photo was given. A retry reuses it instead of reserving the photo again. */
  reservedIds: ReadonlyMap<string, string>;
  onReserved: (photo: PickedPhoto, photoId: string) => void;
  /** The API refused to sign a reused reservation's links, so the next retry has to reserve the photo again. */
  onReservationLost: (photo: PickedPhoto) => void;
  /** The server has marked the photo uploaded. */
  onUploaded: (photo: PickedPhoto) => void;
}

type PhotoOutcome = "uploaded" | "failed" | "unsigned";

// A missing Clerk session is thrown instead of reported, since retrying the photo can't fix it.
async function uploadPhoto(
  splatId: string,
  photo: PickedPhoto,
  photoId: string,
  getToken: () => Promise<string | null>,
): Promise<PhotoOutcome> {
  const { file, thumbnail } = photo;

  const presignToken = await requireToken(getToken);
  let urls: PhotoUploadUrls;
  try {
    urls = await apiFetch<PhotoUploadUrls>(
      `/api/v1/splats/${splatId}/photos/${photoId}/presign`,
      "POST",
      presignToken,
      { thumbnailSize: thumbnail.size },
    );
  } catch {
    return "unsigned";
  }

  try {
    // Both land before the photo is marked uploaded, so an uploaded photo always has its thumbnail.
    const responses = await Promise.all([
      fetch(urls.photoPutUrl, { headers: { "Content-Type": file.type }, method: "PUT", body: file }),
      fetch(urls.thumbnailPutUrl, { headers: { "Content-Type": "image/jpeg" }, method: "PUT", body: thumbnail }),
    ]);
    if (responses.some(response => !response.ok)) {
      return "failed";
    }
  } catch {
    return "failed";
  }

  const completeToken = await requireToken(getToken);
  try {
    await apiFetch<void>(`/api/v1/splats/${splatId}/photos/${photoId}/complete`, "POST", completeToken);
  } catch {
    return "failed";
  }

  return "uploaded";
}

/**
 * getToken is Clerk's, called before each API request. A Clerk session token lasts 60 seconds, which a large batch's
 * uploads outlast. Resolves or rejects only once every photo already started has finished, so no upload is still
 * running when the caller offers a retry.
 */
export async function uploadPhotos(
  splatId: string,
  photos: PickedPhoto[],
  getToken: () => Promise<string | null>,
  progress: UploadProgress,
): Promise<void> {
  // A retry whose failed photos were all removed has nothing left to send.
  if (photos.length === 0) {
    return;
  }

  const photoIds = new Map(progress.reservedIds);
  const unreserved = photos.filter(photo => !photoIds.has(fileKey(photo.file)));
  // The reserve route rejects an empty batch.
  if (unreserved.length > 0) {
    const reservations = await apiFetch<PhotoReservation[]>(
      `/api/v1/splats/${splatId}/photos/reserve`,
      "POST",
      await requireToken(getToken),
      unreserved.map(({ file, width, height, takenAt }) => ({
        filename: file.name,
        contentType: file.type || "image/jpeg",
        size: file.size,
        width,
        height,
        takenAt: new Date(takenAt).toISOString(),
      })),
    );
    unreserved.forEach((photo, index) => {
      photoIds.set(fileKey(photo.file), reservations[index].photoId);
      progress.onReserved(photo, reservations[index].photoId);
    });
  }

  // Each lane takes the next photo once its last one finishes. A thrown error stops every lane from taking another,
  // and is rethrown once the photos already started have finished.
  let failedCount = 0;
  let next = 0;
  let stopped = false;
  let stopError: unknown;
  async function runLane() {
    while (!stopped && next < photos.length) {
      const photo = photos[next];
      next += 1;
      const key = fileKey(photo.file);

      let outcome: PhotoOutcome;
      try {
        outcome = await uploadPhoto(splatId, photo, photoIds.get(key) as string, getToken);
      } catch (err) {
        stopped = true;
        stopError = err;
        return;
      }

      if (outcome === "uploaded") {
        progress.onUploaded(photo);
      } else {
        failedCount += 1;
        if (outcome === "unsigned" && progress.reservedIds.has(key)) {
          progress.onReservationLost(photo);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PHOTOS_IN_FLIGHT, photos.length) }, runLane));

  if (stopped) {
    throw stopError;
  }

  // A failed photo never reaches onUploaded, so the caller's retry sends it again. This throw is what tells
  // web/components/splats/NewSplatForm.tsx that at least one upload failed, so it doesn't treat a failed batch as a
  // success.
  if (failedCount > 0) {
    throw new Error(`${failedCount} of ${photos.length} photo upload${photos.length === 1 ? "" : "s"} failed`);
  }
}
