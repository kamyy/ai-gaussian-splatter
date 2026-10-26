/**
 * POST /api/v1/splats/[splatId]/photos/[photoId]/presign: upload links for one reserved photo.
 *
 * Returns presigned URLs (time-limited links that let the browser upload straight to S3, AWS's file storage) for the
 * photo and its thumbnail. The browser calls this just before uploading each photo, because a batch can take longer
 * to upload than the links last. web/app/api/v1/splats/[splatId]/photos/reserve/route.ts has already applied the
 * rate limits and the photo's size limit, so this route only signs URLs for a pending photo row it created.
 */

import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { photos, splats } from "@/lib/server/db/schema";
import { HttpError, parseJsonBody, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { MAX_THUMBNAIL_BYTES, presignPhotoThumbnailUpload, presignPhotoUpload } from "@/lib/server/s3";
import { PhotoUploadStatus } from "@/lib/statuses";
import type { PhotoUploadUrls } from "@/lib/types";

// The browser draws the thumbnail just before uploading, so its size arrives here rather than with the reservation.
const presignSchema = z.object({
  thumbnailSize: z.number().int().positive().max(MAX_THUMBNAIL_BYTES),
});

export const POST = withErrorHandling(
  async (request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/photos/[photoId]/presign">) => {
    const user = await requireUser();
    const { splatId, photoId } = await ctx.params;
    requireUuid(splatId, 404, "Photo not found");
    requireUuid(photoId, 404, "Photo not found");

    const { thumbnailSize } = await parseJsonBody(request, presignSchema);

    // Ownership is enforced through the parent splat, hence the join.
    const [photo] = await getDb()
      .select({
        s3Key: photos.s3Key,
        thumbnailS3Key: photos.thumbnailS3Key,
        contentType: photos.contentType,
        sizeBytes: photos.sizeBytes,
        uploadStatus: photos.uploadStatus,
      })
      .from(photos)
      .innerJoin(splats, eq(photos.splatId, splats.id))
      .where(and(eq(photos.id, photoId), eq(photos.splatId, splatId), eq(splats.userId, user.id)))
      .limit(1);
    if (photo === undefined) {
      throw new HttpError(404, "Photo not found");
    }

    // An uploaded photo may already be in a worker job, so its objects are never overwritten.
    if (photo.uploadStatus !== PhotoUploadStatus.pending) {
      throw new HttpError(409, "Photo is already uploaded");
    }

    // The reserve route always sets both, so a row missing either wasn't reserved for upload. The size is what the
    // photo's link signs in.
    if (photo.sizeBytes === null || photo.thumbnailS3Key === null) {
      throw new HttpError(409, "Photo can't be uploaded");
    }

    const urls: PhotoUploadUrls = {
      photoPutUrl: await presignPhotoUpload(photo.s3Key, photo.contentType, photo.sizeBytes),
      thumbnailPutUrl: await presignPhotoThumbnailUpload(photo.thumbnailS3Key, thumbnailSize),
    };

    return NextResponse.json(urls);
  },
);
