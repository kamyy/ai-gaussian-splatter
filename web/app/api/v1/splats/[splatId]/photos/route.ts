import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { photos, splats } from "@/lib/server/db/schema";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { presignPhotoDownload } from "@/lib/server/s3";
import { photoColumns } from "@/lib/server/selects";
import type { PhotoListItem } from "@/lib/types";

export const GET = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/photos">) => {
    const user = await requireUser();
    const { splatId } = await ctx.params;
    requireUuid(splatId, 404, "Splat not found");

    // Ownership enforced through the parent splat, same join pattern as jobs/latest/route.ts.
    const [splat] = await getDb()
      .select({ id: splats.id })
      .from(splats)
      .where(and(eq(splats.id, splatId), eq(splats.userId, user.id)))
      .limit(1);
    if (splat === undefined) {
      throw new HttpError(404, "Splat not found");
    }

    const rows = await getDb()
      .select(photoColumns)
      .from(photos)
      .where(and(eq(photos.splatId, splatId), eq(photos.uploadStatus, "uploaded")))
      .orderBy(photos.createdAt);

    const items: PhotoListItem[] = await Promise.all(
      rows.map(async row => ({
        id: row.id,
        originalFilename: row.originalFilename,
        url: await presignPhotoDownload(row.s3Key),
      })),
    );
    return NextResponse.json(items);
  },
);
