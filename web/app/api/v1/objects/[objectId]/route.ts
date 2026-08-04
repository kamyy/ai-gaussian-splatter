import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { splats } from "@/lib/server/db/schema";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { splatReadColumns } from "@/lib/server/selects";

export const GET = withErrorHandling(async (_request: NextRequest, ctx: RouteContext<"/api/v1/objects/[objectId]">) => {
  const user = await requireUser();
  const { objectId } = await ctx.params;
  requireUuid(objectId, 404, "Object not found");

  // Scoped by userId, and a miss is a 404 rather than a 403 — someone else's
  // object is indistinguishable from a nonexistent one.
  const [splat] = await getDb()
    .select(splatReadColumns)
    .from(splats)
    .where(and(eq(splats.id, objectId), eq(splats.userId, user.id)))
    .limit(1);
  if (splat === undefined) {
    throw new HttpError(404, "Object not found");
  }
  return NextResponse.json(splat);
});
