/**
 * POST /api/v1/splats/[splatId]/photos/reserve: permission to upload a batch of photos.
 *
 * Creates a pending row for each photo and returns their ids. The browser then asks
 * web/app/api/v1/splats/[splatId]/photos/[photoId]/presign/route.ts for each photo's upload links just before
 * uploading it, so a long batch never outlasts them. This route is where upload abuse is stopped: the per-photo size
 * limit, the per-splat photo limit, and the per-IP and per-user rate limits all apply here, before any storage is used.
 */

import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { MAX_PHOTO_BYTES, MAX_PHOTOS_PER_SPLAT, PHOTO_EXTENSIONS } from "@/lib/limits";
import { getClientIp, requireOwnedSplat, requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { type NewPhoto, photos } from "@/lib/server/db/schema";
import { HttpError, parseJsonBody, withErrorHandling } from "@/lib/server/httpError";
import { checkAndIncrementIp, checkAndIncrementUser } from "@/lib/server/rateLimit";
import { getRuntimeSettings } from "@/lib/server/runtimeSettings";
import { photoS3Key, photoThumbnailS3Key } from "@/lib/server/s3";
import { PhotoUploadStatus } from "@/lib/statuses";
import type { PhotoReservation } from "@/lib/types";

const reserveSchema = z
  .array(
    z.object({
      filename: z.string().min(1),
      contentType: z.string().refine(type => Object.hasOwn(PHOTO_EXTENSIONS, type), "Unsupported photo type"),
      size: z.number().int().positive().max(MAX_PHOTO_BYTES),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      takenAt: z.iso.datetime(),
    }),
  )
  .min(1);

export const POST = withErrorHandling(
  async (request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/photos/reserve">) => {
    const user = await requireUser();
    const { splatId } = await ctx.params;
    await requireOwnedSplat(splatId, user.id);

    const batch = await parseJsonBody(request, reserveSchema);

    // Checked before the rate limits below, so a batch this rejects doesn't spend the caller's quota. Only uploaded
    // photos count, because a failed batch's pending rows are never uploaded and so never reach the worker.
    const [uploaded] = await getDb()
      .select({ n: count() })
      .from(photos)
      .where(and(eq(photos.splatId, splatId), eq(photos.uploadStatus, PhotoUploadStatus.uploaded)));
    if (uploaded.n + batch.length > MAX_PHOTOS_PER_SPLAT) {
      throw new HttpError(400, `A splat can have at most ${MAX_PHOTOS_PER_SPLAT} photos`);
    }

    // Both checks run before any photo row exists, and the presign route only signs URLs for an existing row. The
    // per-IP limit is the real defense against one person using many accounts, and the per-user limit is a quota on
    // top of it.
    const { uploadsPerIpPerHour, uploadsPerUserPerDay } = await getRuntimeSettings();
    await checkAndIncrementIp(getClientIp(request), uploadsPerIpPerHour);
    await checkAndIncrementUser(user.id, uploadsPerUserPerDay);

    const items: PhotoReservation[] = [];
    const rows: NewPhoto[] = [];
    for (const item of batch) {
      const photoId = randomUUID();
      rows.push({
        id: photoId,
        splatId,
        s3Key: photoS3Key(splatId, photoId, PHOTO_EXTENSIONS[item.contentType]),
        originalFilename: item.filename,
        contentType: item.contentType,
        sizeBytes: item.size,
        width: item.width,
        height: item.height,
        thumbnailS3Key: photoThumbnailS3Key(splatId, photoId),
        takenAt: new Date(item.takenAt),
        uploadStatus: PhotoUploadStatus.pending,
      });
      items.push({ photoId });
    }

    // One insert, not one per photo, so a failure can't leave a partial batch of pending rows behind with the caller
    // holding no ids to retry against.
    await getDb().insert(photos).values(rows);

    return NextResponse.json(items);
  },
);
