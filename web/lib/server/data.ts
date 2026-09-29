/**
 * Database reads for the public share page, called directly by Server Components.
 *
 * The share page (web/app/(public)/preview/splats/[id]/page.tsx) and its link-preview metadata render from these
 * without anyone signing in. They return the splat, its point cloud and its photos' thumbnails as presigned URLs
 * (time-limited S3 links). They live outside the Route Handlers so Server Components can call them directly, rather
 * than the server making an HTTP request to itself.
 */

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { and, asc, desc, eq } from "drizzle-orm";

import type { PublicSplat, PublicSplatView } from "../types";
import { getDb } from "./db";
import { jobs, photos, splats } from "./db/schema";
import { getEnv } from "./env";
import { isUuid } from "./httpError";

// The page is rendered once and never re-fetches its links, so they outlive the owner's page's 15 minutes. The viewer
// loads a 3D file when the visitor switches to it, and the grid loads thumbnails as the visitor pages through them.
// Either can happen long after the page rendered.
const PUBLIC_URL_EXPIRY_SECONDS = 3600;

async function presignPublic(bucket: string, key: string): Promise<string> {
  const client = new S3Client({ region: getEnv().AWS_REGION });

  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: PUBLIC_URL_EXPIRY_SECONDS,
  });
}

/**
 * Returns only complete, shareable splats. Anything else is null, which callers turn into a 404, the same as a splat
 * that doesn't exist.
 */
export async function getPublicSplat(splatId: string): Promise<PublicSplat | null> {
  if (!isUuid(splatId)) {
    return null;
  }

  const [splat] = await getDb()
    .select()
    .from(splats)
    .where(and(eq(splats.id, splatId), eq(splats.status, "complete"), eq(splats.isShareable, true)))
    .limit(1);
  if (splat === undefined || splat.thumbnailS3Key === null) {
    return null;
  }

  const [latestJob] = await getDb()
    .select()
    .from(jobs)
    .where(and(eq(jobs.splatId, splatId), eq(jobs.status, "complete")))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  if (latestJob === undefined || latestJob.resultSpzS3Key === null) {
    return null;
  }

  const { SPLATS_BUCKET } = getEnv();

  return {
    title: splat.name,
    thumbnailUrl: await presignPublic(SPLATS_BUCKET, splat.thumbnailS3Key),
    splatUrl: await presignPublic(SPLATS_BUCKET, latestJob.resultSpzS3Key),
    pointCloudUrl: latestJob.pointCloudS3Key ? await presignPublic(SPLATS_BUCKET, latestJob.pointCloudS3Key) : null,
  };
}

/**
 * Everything the share page shows: the public splat plus its photos. Null exactly when getPublicSplat is.
 *
 * Only photos with a thumbnail are included, because the original file can carry EXIF data such as GPS position.
 */
export async function getPublicSplatView(splatId: string): Promise<PublicSplatView | null> {
  const splat = await getPublicSplat(splatId);
  if (splat === null) {
    return null;
  }

  // The same order as web/app/api/v1/splats/[splatId]/photos/route.ts, so "Photo 3" is the third photo the owner sees.
  const rows = await getDb()
    .select({
      id: photos.id,
      thumbnailS3Key: photos.thumbnailS3Key,
      width: photos.width,
      height: photos.height,
    })
    .from(photos)
    .where(and(eq(photos.splatId, splatId), eq(photos.uploadStatus, "uploaded")))
    .orderBy(asc(photos.takenAt), asc(photos.createdAt), asc(photos.id));
  const withThumbnails = rows.flatMap(({ thumbnailS3Key, ...photo }) =>
    thumbnailS3Key === null ? [] : [{ ...photo, thumbnailS3Key }],
  );

  const { UPLOADS_BUCKET } = getEnv();
  const publicPhotos = await Promise.all(
    withThumbnails.map(async (photo, index) => ({
      id: photo.id,
      originalFilename: `Photo ${index + 1}`,
      thumbnailUrl: await presignPublic(UPLOADS_BUCKET, photo.thumbnailS3Key),
      width: photo.width,
      height: photo.height,
    })),
  );

  return { ...splat, photos: publicPhotos };
}
