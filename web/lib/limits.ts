/**
 * The upload limits: how many photos a splat can have, and how large each one can be.
 *
 * They live outside web/lib/server/ because the browser enforces them as well as the API routes. The browser checks
 * them first so a visitor hears about a problem straight away. The server checks them again because a client can skip
 * the browser's checks.
 */

/**
 * The most photos one splat can hold. COLMAP's exhaustive matcher (worker/pipeline/sfm.py) compares every pair of
 * photos, so reconstruct time grows with the square of this number. 100 is twice the capture guide's target of 50.
 */
export const MAX_PHOTOS_PER_SPLAT = 100;

/**
 * The largest one photo can be, in bytes. It bounds what a photo costs in S3 storage and in worker download time. The
 * worker downsamples every photo to worker/pipeline/train.py's MAX_TRAINING_EDGE, so a bigger file adds nothing to the
 * splat. 30 MB still admits a full-resolution phone JPEG.
 */
export const MAX_PHOTO_BYTES = 30 * 1024 * 1024;

/**
 * The photo types an upload can declare, each with the extension its S3 key gets. They are the formats
 * worker/pipeline/sfm.py hands to COLMAP, so a photo of any other type would upload and then never reach the
 * reconstruction. The extension comes from here rather than from the uploaded filename, so S3 never serves a stored
 * object as HTML or script.
 */
export const PHOTO_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
};

/**
 * A photo whose long side is shorter than this is flagged as low resolution before upload, and web/lib/measurePhoto.ts
 * scores every photo's sharpness at this size. It matches
 * worker/pipeline/train.py's MAX_TRAINING_EDGE, the size training works at, so a smaller photo makes a softer splat.
 * Advisory only: the server doesn't check it.
 */
export const MIN_SHARP_PHOTO_EDGE = 1600;
