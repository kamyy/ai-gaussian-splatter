import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { splats } from "@/lib/server/db/schema";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { splatReadColumns } from "@/lib/server/selects";

export const GET = withErrorHandling(async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]">) => {
  const user = await requireUser();
  const { splatId } = await ctx.params;
  requireUuid(splatId, 404, "Splat not found");

  // Scoped by userId, and a miss is a 404 rather than a 403 — someone else's splat is indistinguishable from a
  // nonexistent one.
  const [splat] = await getDb()
    .select(splatReadColumns)
    .from(splats)
    .where(and(eq(splats.id, splatId), eq(splats.userId, user.id)))
    .limit(1);
  if (splat === undefined) {
    throw new HttpError(404, "Splat not found");
  }
  return NextResponse.json(splat);
});
