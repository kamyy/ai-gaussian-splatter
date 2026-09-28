// A photo picked for upload, with its size as an <img> displays it, a small JPEG copy, and when it was taken.
// web/components/splats/NewSplatForm.tsx measures each photo as it's added, so every photo that reaches
// web/lib/uploadPhotos.ts has all three to store.
export interface PickedPhoto {
  file: File;
  width: number;
  height: number;
  thumbnail: Blob;
  // Milliseconds since the epoch.
  takenAt: number;
}

// Long enough that a library card, the largest place a thumbnail shows, stays sharp on a high-resolution screen.
export const THUMBNAIL_LONG_SIDE = 640;
const THUMBNAIL_QUALITY = 0.8;

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

// createImageBitmap applies the EXIF orientation by default, so a portrait phone photo stored sideways still measures
// as portrait, and its thumbnail comes out upright. Null for a format this browser can't decode, such as HEIC outside
// Safari.
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
    };
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

// A decoded 12-megapixel photo holds about 48 MB, so decoding a whole drop at once can exhaust the tab's memory. Only
// this many are decoded at a time.
export const MEASURE_CONCURRENCY = 4;

// Results line up with files, with null for each photo measurePhoto couldn't decode.
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
