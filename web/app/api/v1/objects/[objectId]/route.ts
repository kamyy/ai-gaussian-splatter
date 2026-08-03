import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { getPrisma } from "@/lib/server/prisma";
import { splatReadSelect } from "@/lib/server/selects";

export const GET = withErrorHandling(async (_request: NextRequest, ctx: RouteContext<"/api/v1/objects/[objectId]">) => {
  const user = await requireUser();
  const { objectId } = await ctx.params;
  requireUuid(objectId, 404, "Object not found");

  // Scoped by userId, and a miss is a 404 rather than a 403 — someone else's
  // object is indistinguishable from a nonexistent one.
  const splat = await getPrisma().splat.findFirst({
    where: { id: objectId, userId: user.id },
    select: splatReadSelect,
  });
  if (splat === null) {
    throw new HttpError(404, "Object not found");
  }
  return NextResponse.json(splat);
});
