import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { and, desc, eq } from "drizzle-orm";

import type { PublicSplat } from "../types";
import { getDb } from "./db";
import { jobs, splats } from "./db/schema";
import { getEnv } from "./env";
import { isUuid } from "./httpError";
import { presignSplatDownload } from "./s3";

/**
 * Public, unauthenticated reads — what the share pages render from, including generateMetadata's og:title/og:image.
 *
 * These live outside the Route Handlers so Server Components can call them directly rather than having the server make
 * an HTTP request to itself.
 */

const THUMBNAIL_EXPIRY_SECONDS = 3600;

async function thumbnailUrl(key: string): Promise<string> {
  const env = getEnv();
  const client = new S3Client({ region: env.AWS_REGION });
  return getSignedUrl(client, new GetObjectCommand({ Bucket: env.SPLATS_BUCKET, Key: key }), {
    expiresIn: THUMBNAIL_EXPIRY_SECONDS,
  });
}

/**
 * Only exposes Complete + shareable splats — else null, which callers surface as a 404, same as if it simply didn't
 * exist.
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
  if (latestJob === undefined || latestJob.resultS3Key === null) {
    return null;
  }

  return {
    title: splat.name,
    thumbnailUrl: await thumbnailUrl(splat.thumbnailS3Key),
    splatUrl: await presignSplatDownload(latestJob.resultS3Key),
  };
}
