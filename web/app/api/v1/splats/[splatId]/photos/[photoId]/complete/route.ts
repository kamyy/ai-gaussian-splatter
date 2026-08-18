import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { photos, splats } from "@/lib/server/db/schema";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";

export const POST = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/photos/[photoId]/complete">) => {
    const user = await requireUser();
    const { splatId, photoId } = await ctx.params;
    requireUuid(splatId, 404, "Photo not found");
    requireUuid(photoId, 404, "Photo not found");

    // Ownership is enforced through the parent splat, hence the join.
    const [photo] = await getDb()
      .select({ id: photos.id })
      .from(photos)
      .innerJoin(splats, eq(photos.splatId, splats.id))
      .where(and(eq(photos.id, photoId), eq(photos.splatId, splatId), eq(splats.userId, user.id)))
      .limit(1);
    if (photo === undefined) {
      throw new HttpError(404, "Photo not found");
    }

    await getDb().update(photos).set({ uploadStatus: "uploaded" }).where(eq(photos.id, photoId));
    return new NextResponse(null, { status: 204 });
  },
);
