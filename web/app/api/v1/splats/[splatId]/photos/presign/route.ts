/**
 * POST /api/v1/splats/[splatId]/photos/presign: permission to upload a batch of photos.
 *
 * Creates a pending row for each photo and returns presigned URLs (time-limited links that let the browser upload
 * straight to S3, AWS's file storage) for the photo and its thumbnail. It is also where upload abuse is stopped: the
 * per-photo size limits, the per-splat photo limit, and the per-IP and per-user rate limits all apply here, before any
 * storage is used.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, count, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { MAX_PHOTO_BYTES, MAX_PHOTOS_PER_SPLAT } from "@/lib/limits";
import { getClientIp, requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { type NewPhoto, photos, splats } from "@/lib/server/db/schema";
import { getEnv } from "@/lib/server/env";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { checkAndIncrementIp, checkAndIncrementUser } from "@/lib/server/rateLimit";
import { MAX_THUMBNAIL_BYTES, presignPhotoThumbnailUpload, presignPhotoUpload } from "@/lib/server/s3";
import type { PhotoPresignItem } from "@/lib/types";

// Rate limiting happens here: it gates *before* any upload happens (per-IP + per-user), separate from the global daily
// cap, which only gates the expensive job-launch step (web/app/api/v1/splats/[splatId]/process/route.ts).
const presignSchema = z
  .array(
    z.object({
      filename: z.string().min(1),
      contentType: z.string().min(1),
      size: z.number().int().positive().max(MAX_PHOTO_BYTES),
      thumbnailSize: z.number().int().positive().max(MAX_THUMBNAIL_BYTES),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      takenAt: z.iso.datetime(),
    }),
  )
  .min(1);

export const POST = withErrorHandling(
  async (request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/photos/presign">) => {
    const env = getEnv();
    const user = await requireUser();
    const { splatId } = await ctx.params;
    requireUuid(splatId, 404, "Splat not found");

    const [splat] = await getDb()
      .select({ id: splats.id })
      .from(splats)
      .where(and(eq(splats.id, splatId), eq(splats.userId, user.id)))
      .limit(1);
    if (splat === undefined) {
      throw new HttpError(404, "Splat not found");
    }

    const parsed = presignSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(422, "Invalid request body");
    }

    // Checked before the rate limits below, so a batch this rejects doesn't spend the caller's quota. Only uploaded
    // photos count, because a failed batch's pending rows are never uploaded and so never reach the worker.
    const [uploaded] = await getDb()
      .select({ n: count() })
      .from(photos)
      .where(and(eq(photos.splatId, splatId), eq(photos.uploadStatus, "uploaded")));
    if (uploaded.n + parsed.data.length > MAX_PHOTOS_PER_SPLAT) {
      throw new HttpError(400, `A splat can have at most ${MAX_PHOTOS_PER_SPLAT} photos`);
    }

    // Both checks run before any S3 URL is issued. The per-IP limit is the real defense against one person using many
    // accounts, and the per-user limit is a quota on top of it.
    await checkAndIncrementIp(getClientIp(request), env.RATE_LIMIT_IP_PER_HOUR);
    await checkAndIncrementUser(user.id, env.RATE_LIMIT_USER_PER_DAY);

    const items: PhotoPresignItem[] = [];
    const rows: NewPhoto[] = [];
    for (const item of parsed.data) {
      const photoId = randomUUID();
      const extension = path.extname(item.filename) || ".jpg";
      const { key, url } = await presignPhotoUpload(splatId, photoId, extension, item.contentType, item.size);
      const thumbnail = await presignPhotoThumbnailUpload(splatId, photoId, item.thumbnailSize);

      rows.push({
        id: photoId,
        splatId,
        s3Key: key,
        originalFilename: item.filename,
        contentType: item.contentType,
        sizeBytes: item.size,
        width: item.width,
        height: item.height,
        thumbnailS3Key: thumbnail.key,
        takenAt: new Date(item.takenAt),
        uploadStatus: "pending",
      });
      items.push({ photoId, presignedPutUrl: url, s3Key: key, thumbnailPutUrl: thumbnail.url });
    }

    // One insert, not one per photo: a mid-loop failure would otherwise leave a partial batch of pending rows behind,
    // with the caller holding no ids to retry against and the rate-limit increment already spent.
    await getDb().insert(photos).values(rows);

    return NextResponse.json(items);
  },
);
