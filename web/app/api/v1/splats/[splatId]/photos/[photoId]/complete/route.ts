/**
 * POST /api/v1/splats/[splatId]/photos/[photoId]/complete: confirm a photo finished uploading.
 *
 * The browser uploads each photo straight to S3 (AWS's file storage), so the app never sees the bytes. It calls this
 * afterwards, and the route checks the objects really are in S3 and within the size limits before marking the photo
 * uploaded. Only uploaded photos reach the worker.
 */

import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { MAX_PHOTO_BYTES } from "@/lib/limits";
import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { photos, splats } from "@/lib/server/db/schema";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { deleteUploadedObject, MAX_THUMBNAIL_BYTES, uploadedObjectSize } from "@/lib/server/s3";
import { PhotoUploadStatus } from "@/lib/statuses";

export const POST = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/photos/[photoId]/complete">) => {
    const user = await requireUser();
    const { splatId, photoId } = await ctx.params;
    requireUuid(splatId, 404, "Photo not found");
    requireUuid(photoId, 404, "Photo not found");

    // Ownership is enforced through the parent splat, hence the join.
    const [photo] = await getDb()
      .select({ id: photos.id, s3Key: photos.s3Key, thumbnailS3Key: photos.thumbnailS3Key })
      .from(photos)
      .innerJoin(splats, eq(photos.splatId, splats.id))
      .where(and(eq(photos.id, photoId), eq(photos.splatId, splatId), eq(splats.userId, user.id)))
      .limit(1);
    if (photo === undefined) {
      throw new HttpError(404, "Photo not found");
    }

    // The objects themselves are checked rather than trusting the caller. The sizes signed into the upload URLs
    // (web/lib/server/s3.ts) already stop an honest browser, so this is what stops a client that skipped them.
    const size = await uploadedObjectSize(photo.s3Key);
    if (size === null) {
      throw new HttpError(400, "Photo has not been uploaded");
    }

    if (size > MAX_PHOTO_BYTES) {
      await deleteUploadedObject(photo.s3Key);
      throw new HttpError(400, `A photo can be at most ${MAX_PHOTO_BYTES / (1024 * 1024)} MB`);
    }

    // Null only for a photo uploaded before thumbnails existed, which never reaches this route again.
    if (photo.thumbnailS3Key !== null) {
      const thumbnailSize = await uploadedObjectSize(photo.thumbnailS3Key);
      if (thumbnailSize === null) {
        throw new HttpError(400, "Thumbnail has not been uploaded");
      }

      if (thumbnailSize > MAX_THUMBNAIL_BYTES) {
        await deleteUploadedObject(photo.thumbnailS3Key);
        throw new HttpError(400, "Thumbnail is too large");
      }
    }

    await getDb().update(photos).set({ uploadStatus: PhotoUploadStatus.uploaded }).where(eq(photos.id, photoId));

    return new NextResponse(null, { status: 204 });
  },
);
