/**
 * Everything the app stores in S3, AWS's file storage: photo uploads, and the worker's results.
 *
 * Builds the object keys (paths) photos are stored under, and presigned URLs, time-limited links that let the browser
 * upload or download a file directly without the app handling the bytes. It also reads back an object's size, and
 * deletes a splat's objects. Uploads are only presigned by the API, so the rate limit is enforced before any bytes
 * reach S3.
 */

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { CameraPose } from "@/lib/types";
import { getEnv } from "./env";

const PRESIGN_EXPIRY_SECONDS = 15 * 60;

function s3Client(): S3Client {
  return new S3Client({ region: getEnv().AWS_REGION });
}

export function photoS3Key(splatId: string, photoId: string, extension: string): string {
  return `splats/${splatId}/photos/${photoId}${extension}`;
}

/**
 * A photo's thumbnail sits beside, not under, photos/. The worker downloads everything under splats/<splatId>/photos/
 * (worker/pipeline/fetch.py) and hands it to COLMAP, which would treat a thumbnail as another photo.
 */
export function photoThumbnailS3Key(splatId: string, photoId: string): string {
  return `splats/${splatId}/photo-thumbnails/${photoId}.jpg`;
}

/**
 * Returns the S3 key alongside the presigned PUT URL. contentLength is signed into the URL, so S3 rejects a body of
 * any other size. That is what makes the presign route's size check binding on the upload itself.
 */
export async function presignPhotoUpload(
  splatId: string,
  photoId: string,
  extension: string,
  contentType: string,
  contentLength: number,
): Promise<{ key: string; url: string }> {
  const env = getEnv();
  const key = photoS3Key(splatId, photoId, extension);
  const command = new PutObjectCommand({
    Bucket: env.UPLOADS_BUCKET,
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
  });
  const url = await getSignedUrl(s3Client(), command, { expiresIn: PRESIGN_EXPIRY_SECONDS });
  return { key, url };
}

/**
 * The largest a thumbnail can be, in bytes. web/lib/measurePhoto.ts draws it at THUMBNAIL_LONG_SIDE pixels, which
 * comes out well under this. The cap exists because the client, not the server, produces the thumbnail.
 */
export const MAX_THUMBNAIL_BYTES = 1024 * 1024;

/**
 * A thumbnail is always a JPEG, drawn in the browser by web/lib/measurePhoto.ts. contentLength is signed into the URL
 * for the same reason as presignPhotoUpload's.
 */
export async function presignPhotoThumbnailUpload(
  splatId: string,
  photoId: string,
  contentLength: number,
): Promise<{ key: string; url: string }> {
  const env = getEnv();
  const key = photoThumbnailS3Key(splatId, photoId);
  const command = new PutObjectCommand({
    Bucket: env.UPLOADS_BUCKET,
    Key: key,
    ContentType: "image/jpeg",
    ContentLength: contentLength,
  });
  const url = await getSignedUrl(s3Client(), command, { expiresIn: PRESIGN_EXPIRY_SECONDS });
  return { key, url };
}

/** The size in bytes of an object in UPLOADS_BUCKET, or null when there is no object at that key. */
export async function uploadedObjectSize(uploadsBucketKey: string): Promise<number | null> {
  try {
    const response = await s3Client().send(
      new HeadObjectCommand({ Bucket: getEnv().UPLOADS_BUCKET, Key: uploadsBucketKey }),
    );
    return response.ContentLength ?? null;
  } catch (err) {
    if (err instanceof Error && err.name === "NotFound") {
      return null;
    }

    throw err;
  }
}

export async function deleteUploadedObject(uploadsBucketKey: string): Promise<void> {
  await s3Client().send(new DeleteObjectCommand({ Bucket: getEnv().UPLOADS_BUCKET, Key: uploadsBucketKey }));
}

export async function presignSplatDownload(splatsBucketKey: string): Promise<string> {
  const env = getEnv();
  const command = new GetObjectCommand({ Bucket: env.SPLATS_BUCKET, Key: splatsBucketKey });

  return getSignedUrl(s3Client(), command, { expiresIn: PRESIGN_EXPIRY_SECONDS });
}

/** Uploaded photos live in UPLOADS_BUCKET (see presignPhotoUpload above), not SPLATS_BUCKET. */
export async function presignPhotoDownload(uploadsBucketKey: string): Promise<string> {
  const env = getEnv();
  const command = new GetObjectCommand({ Bucket: env.UPLOADS_BUCKET, Key: uploadsBucketKey });

  return getSignedUrl(s3Client(), command, { expiresIn: PRESIGN_EXPIRY_SECONDS });
}

/**
 * Deletes everything stored for a splat. Both buckets key a splat's objects under `splats/<splatId>/`: its photos in
 * the uploads bucket (photoS3Key above), and the worker's point cloud, result and thumbnail in the splats bucket.
 */
export async function deleteSplatObjects(splatId: string): Promise<void> {
  const env = getEnv();
  const client = s3Client();
  for (const bucket of [env.UPLOADS_BUCKET, env.SPLATS_BUCKET]) {
    let continuationToken: string | undefined;
    do {
      // A list page holds at most 1000 keys, which is also DeleteObjects' per-request limit.
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: `splats/${splatId}/`,
          ContinuationToken: continuationToken,
        }),
      );
      const keys = (page.Contents ?? []).flatMap(object => (object.Key ? [{ Key: object.Key }] : []));
      if (keys.length > 0) {
        await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
      }

      continuationToken = page.NextContinuationToken;
    } while (continuationToken);
  }
}

type WorkerCamera = Omit<CameraPose, "photoId"> & { name: string };

/**
 * The camera poses the reconstruct stage wrote beside the point cloud (worker/pipeline/sparse_export.py), keyed back to
 * photo ids. The worker names each photo after its S3 key's last segment, `<photoId><extension>` (photoS3Key above), so
 * stripping the extension recovers the id. null when the object doesn't exist, which is every job reconstructed before
 * the worker wrote one.
 */
export async function readSplatCameras(splatId: string): Promise<CameraPose[] | null> {
  let body: string | undefined;
  try {
    const response = await s3Client().send(
      new GetObjectCommand({ Bucket: getEnv().SPLATS_BUCKET, Key: `splats/${splatId}/cameras.json` }),
    );
    body = await response.Body?.transformToString();
  } catch (err) {
    if (err instanceof Error && err.name === "NoSuchKey") {
      return null;
    }

    throw err;
  }

  if (body === undefined) {
    return null;
  }

  const { cameras } = JSON.parse(body) as { cameras: WorkerCamera[] };

  return cameras.map(({ name, ...camera }) => ({ photoId: name.replace(/\.[^.]*$/, ""), ...camera }));
}
