import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { getEnv } from "./env";

/**
 * Presigned S3 URLs (plan §4 step 1) — uploads always go through this API so
 * the rate limit is enforced before any bytes hit S3.
 */
const PRESIGN_EXPIRY_SECONDS = 15 * 60;

function s3Client(): S3Client {
  return new S3Client({ region: getEnv().AWS_REGION });
}

export function photoS3Key(objectId: string, photoId: string, extension: string): string {
  return `objects/${objectId}/photos/${photoId}${extension}`;
}

/** Returns the S3 key alongside the presigned PUT URL. */
export async function presignPhotoUpload(
  objectId: string,
  photoId: string,
  extension: string,
  contentType: string,
): Promise<{ key: string; url: string }> {
  const env = getEnv();
  const key = photoS3Key(objectId, photoId, extension);
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

export async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    // HeadObject returns a bare 404 with no body, so the SDK surfaces it as
    // NotFound rather than NoSuchKey — check both.
    const name = (error as { name?: string })?.name;
    const statusCode = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (name === "NotFound" || name === "NoSuchKey" || statusCode === 404) {
      return false;
    }
    throw error;
  }
}
