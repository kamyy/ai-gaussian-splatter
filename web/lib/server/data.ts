import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { GalleryItemRead, PublicObjectRead } from "../types";
import { getEnv } from "./env";
import { isUuid } from "./httpError";
import { getPrisma } from "./prisma";
import { presignSplatDownload } from "./s3";

/**
 * Public, unauthenticated reads (plan §3) — what the gallery and share pages
 * render from, including generateMetadata's og:title/og:image.
 *
 * These live outside the Route Handlers so Server Components can call them
 * directly rather than having the server make an HTTP request to itself.
 */

const THUMBNAIL_EXPIRY_SECONDS = 3600;

async function thumbnailUrl(key: string): Promise<string> {
  const env = getEnv();
  const client = new S3Client({ region: env.AWS_REGION });
  return getSignedUrl(client, new GetObjectCommand({ Bucket: env.SPLATS_BUCKET, Key: key }), {
    expiresIn: THUMBNAIL_EXPIRY_SECONDS,
  });
}

export async function listGallery(): Promise<GalleryItemRead[]> {
  const items = await getPrisma().galleryItem.findMany({ orderBy: { displayOrder: "asc" } });
  return Promise.all(
    items.map(async item => ({
      id: item.id,
      title: item.title,
      description: item.description,
      thumbnailUrl: await thumbnailUrl(item.thumbnailS3Key),
      splatUrl: await presignSplatDownload(item.splatS3Key),
    })),
  );
}

export async function getGalleryItem(itemId: string): Promise<GalleryItemRead | null> {
  // Guard here rather than at each call site: these ids come from the URL, and
  // an unparseable one would otherwise reach an `@db.Uuid` column and make
  // Postgres raise 22P02 — a 500 for what is really just "no such row".
  if (!isUuid(itemId)) {
    return null;
  }

  const item = await getPrisma().galleryItem.findUnique({ where: { id: itemId } });
  if (item === null) {
    return null;
  }
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    thumbnailUrl: await thumbnailUrl(item.thumbnailS3Key),
    splatUrl: await presignSplatDownload(item.splatS3Key),
  };
}

/**
 * Only exposes Complete + shareable splats (plan §2's sharing default) — else
 * null, which callers surface as a 404, same as if it simply didn't exist.
 */
export async function getPublicSplat(splatId: string): Promise<PublicObjectRead | null> {
  if (!isUuid(splatId)) {
    return null;
  }

  const splat = await getPrisma().splat.findFirst({
    where: { id: splatId, status: "Complete", isShareable: true },
  });
  if (splat === null || splat.thumbnailS3Key === null) {
    return null;
  }

  const latestJob = await getPrisma().job.findFirst({
    where: { splatId, status: "Complete" },
    orderBy: { createdAt: "desc" },
  });
  if (latestJob === null || latestJob.resultS3Key === null) {
    return null;
  }

  return {
    title: splat.name,
    thumbnailUrl: await thumbnailUrl(splat.thumbnailS3Key),
    splatUrl: await presignSplatDownload(latestJob.resultS3Key),
  };
}
