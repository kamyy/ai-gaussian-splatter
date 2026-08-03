import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { getPrisma } from "@/lib/server/prisma";

export const POST = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/objects/[objectId]/photos/[photoId]/complete">) => {
    const user = await requireUser();
    const { objectId, photoId } = await ctx.params;
    requireUuid(objectId, 404, "Photo not found");
    requireUuid(photoId, 404, "Photo not found");

    // Ownership is enforced through the parent splat, matching the old
    // Photo-join-Object query.
    const photo = await getPrisma().photo.findFirst({
      where: { id: photoId, splatId: objectId, splat: { userId: user.id } },
    });
    if (photo === null) {
      throw new HttpError(404, "Photo not found");
    }

    await getPrisma().photo.update({ where: { id: photoId }, data: { uploadStatus: "Uploaded" } });
    return new NextResponse(null, { status: 204 });
  },
);
