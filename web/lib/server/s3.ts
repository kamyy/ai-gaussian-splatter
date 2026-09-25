import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { CameraPose } from "@/lib/types";
import { getEnv } from "./env";

// Presigned S3 URLs. Uploads always go through this API, so the rate limit is enforced before any bytes hit S3.

const PRESIGN_EXPIRY_SECONDS = 15 * 60;

function s3Client(): S3Client {
  return new S3Client({ region: getEnv().AWS_REGION });
}

export function photoS3Key(splatId: string, photoId: string, extension: string): string {
  return `splats/${splatId}/photos/${photoId}${extension}`;
}

/** Returns the S3 key alongside the presigned PUT URL. */
export async function presignPhotoUpload(
  splatId: string,
  photoId: string,
  extension: string,
  contentType: string,
): Promise<{ key: string; url: string }> {
  const env = getEnv();
  const key = photoS3Key(splatId, photoId, extension);
  const command = new PutObjectCommand({
    Bucket: env.UPLOADS_BUCKET,
    Key: key,
    ContentType: contentType,
  });
  const url = await getSignedUrl(s3Client(), command, { expiresIn: PRESIGN_EXPIRY_SECONDS });
  return { key, url };
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

interface WorkerCamera {
  name: string;
  center: [number, number, number];
  rotation: [number, number, number][];
}

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
  return cameras.map(camera => ({
    photoId: camera.name.replace(/\.[^.]*$/, ""),
    center: camera.center,
    rotation: camera.rotation,
  }));
}
