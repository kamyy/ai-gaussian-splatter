/**
 * GET /api/v1/splats/[splatId]/photos: the splat's uploaded photos.
 *
 * Returns every uploaded photo, oldest taken first, with presigned URLs (time-limited S3 links) for the full image and
 * its thumbnail, plus its pixel size so the photo grid can lay out rows before any image loads.
 */

import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { requireOwnedSplat, requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { photos } from "@/lib/server/db/schema";
import { withErrorHandling } from "@/lib/server/httpError";
import { presignPhotoDownload } from "@/lib/server/s3";
import { photoColumns, photoOrder } from "@/lib/server/selects";
import type { PhotoListItem } from "@/lib/types";

export const GET = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/photos">) => {
    const user = await requireUser();
    const { splatId } = await ctx.params;
    await requireOwnedSplat(splatId, user.id);

    const rows = await getDb()
      .select(photoColumns)
      .from(photos)
      .where(and(eq(photos.splatId, splatId), eq(photos.uploadStatus, "uploaded")))
      .orderBy(...photoOrder);

    const items: PhotoListItem[] = await Promise.all(
      rows.map(async row => ({
        id: row.id,
        originalFilename: row.originalFilename,
        url: await presignPhotoDownload(row.s3Key),
        thumbnailUrl: await presignPhotoDownload(row.thumbnailS3Key ?? row.s3Key),
        width: row.width,
        height: row.height,
      })),
    );

    return NextResponse.json(items);
  },
);
