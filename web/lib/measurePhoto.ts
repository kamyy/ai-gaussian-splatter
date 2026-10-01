/**
 * Reads a picked photo's size, date, sharpness and a small thumbnail in the browser before upload.
 *
 * Decoding each photo on the visitor's machine gives the server the pixel size (which the photo grid needs to lay out
 * rows before images load), when it was taken (from the EXIF data cameras write into the file), and a small JPEG copy
 * for thumbnails. It also scores how sharp the photo is, so the new-splat form can flag a blurry one before it costs a
 * GPU run. A photo this browser can't decode is reported rather than uploaded.
 */

import { MIN_SHARP_PHOTO_EDGE } from "@/lib/limits";

/** Long enough that a library card, the largest place a thumbnail shows, stays sharp on a high-resolution screen. */
const THUMBNAIL_LONG_SIDE = 640;
const THUMBNAIL_QUALITY = 0.8;

/**
 * A decoded 12-megapixel photo holds about 48 MB, so decoding a whole drop at once can exhaust the tab's memory. Only
 * this many are decoded at a time.
 */
export const MEASURE_CONCURRENCY = 4;

/**
 * A photo picked for upload, with its size as an <img> displays it, a small JPEG copy, and when it was taken.
 * web/lib/hooks/usePickedPhotos.ts measures each photo as it's added, so every photo that reaches
 * web/lib/uploadPhotos.ts has all three to store.
 */
export interface PickedPhoto {
  file: File;
  width: number;
  height: number;
  thumbnail: Blob;
  // Milliseconds since the epoch.
  takenAt: number;
  // Higher is sharper. Only meaningful compared with other photos of the same object, since a plain surface scores low
  // however well it's focused.
  sharpness: number;
}

/** Two files with the same name and size from separate drops are the same photo picked twice. */
export function fileKey(file: File) {
  return `${file.name}:${file.size}`;
}

async function makeThumbnail(bitmap: ImageBitmap): Promise<Blob> {
  const scale = Math.min(1, THUMBNAIL_LONG_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("No 2D canvas context");
  }

  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);

  return canvas.convertToBlob({ type: "image/jpeg", quality: THUMBNAIL_QUALITY });
}

/**
 * The variance of the Laplacian of the image's brightness. The Laplacian is large at edges, and blur smooths edges
 * away, so a blurred photo scores lower than a sharp one of the same scene. rgba is canvas ImageData's layout.
 */
export function laplacianVariance(rgba: Uint8ClampedArray, width: number, height: number): number {
  const luma = new Float32Array(width * height);
  for (let i = 0; i < luma.length; i++) {
    luma[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  }

  let sum = 0;
  let sumOfSquares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const laplacian = 4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - width] - luma[i + width];
      sum += laplacian;
      sumOfSquares += laplacian * laplacian;
      count += 1;
    }
  }

  if (count === 0) {
    return 0;
  }

  const mean = sum / count;
  return sumOfSquares / count - mean * mean;
}

// Scored at the size training works at, whatever the photo's own size. Shrinking further would hide blur that still
// softens the splat, and a fixed size keeps photos from different cameras comparable.
function measureSharpness(bitmap: ImageBitmap): number {
  const scale = Math.min(1, MIN_SHARP_PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("No 2D canvas context");
  }

  context.drawImage(bitmap, 0, 0, width, height);

  return laplacianVariance(context.getImageData(0, 0, width, height).data, width, height);
}

// The camera's EXIF capture time, else the file's last-modified time, which copying or sending the file can reset. EXIF
// times carry no time zone, so exifr reads them as local time, which is enough to order one capture's photos. exifr is
// loaded only once a photo is added, so it stays out of every page's initial JavaScript.
async function readTakenAt(file: File): Promise<number> {
  try {
    const { default: exifr } = await import("exifr");
    const exif = await exifr.parse(file, { pick: ["DateTimeOriginal"] });
    if (exif?.DateTimeOriginal instanceof Date && !Number.isNaN(exif.DateTimeOriginal.getTime())) {
      return exif.DateTimeOriginal.getTime();
    }
  } catch {
    // A file with no readable EXIF block falls through to its file time.
  }

  return file.lastModified;
}

/**
 * createImageBitmap applies the EXIF orientation by default, so a portrait phone photo stored sideways still measures
 * as portrait, and its thumbnail comes out upright. Null for a format this browser can't decode, such as HEIC outside
 * Safari.
 */
export async function measurePhoto(file: File): Promise<PickedPhoto | null> {
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file);
    return {
      file,
      width: bitmap.width,
      height: bitmap.height,
      thumbnail: await makeThumbnail(bitmap),
      takenAt: await readTakenAt(file),
      sharpness: measureSharpness(bitmap),
    };
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

/** Results line up with files, with null for each photo measurePhoto couldn't decode. */
export async function measurePhotos(files: File[]): Promise<Array<PickedPhoto | null>> {
  const results: Array<PickedPhoto | null> = new Array(files.length).fill(null);
  let next = 0;

  async function worker() {
    while (next < files.length) {
      const index = next;
      next += 1;
      results[index] = await measurePhoto(files[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(MEASURE_CONCURRENCY, files.length) }, worker));

  return results;
}
