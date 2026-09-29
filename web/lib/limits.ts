// Upload limits. They live outside web/lib/server/ because the browser enforces them as well as the API routes. These
// files enforce them in the browser:
// - web/components/splats/NewSplatForm.tsx
// - web/lib/hooks/usePickedPhotos.ts

// The most photos one splat can hold. COLMAP's exhaustive matcher (worker/pipeline/sfm.py) compares every pair of
// photos, so reconstruct time grows with the square of this number. 100 is twice the capture guide's target of 50.
export const MAX_PHOTOS_PER_SPLAT = 100;

// The largest one photo can be, in bytes. It bounds what a photo costs in S3 storage and in worker download time. The
// worker downsamples every photo to worker/pipeline/train.py's MAX_TRAINING_EDGE, so a bigger file adds nothing to the
// splat. 30 MB still admits a full-resolution phone JPEG or HEIC.
export const MAX_PHOTO_BYTES = 30 * 1024 * 1024;
