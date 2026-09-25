import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { cancelActiveJob } from "@/lib/server/cancelJob";
import { getDb } from "@/lib/server/db";
import { splats } from "@/lib/server/db/schema";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { deleteSplatObjects } from "@/lib/server/s3";
import { splatColumns } from "@/lib/server/selects";

export const GET = withErrorHandling(async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]">) => {
  const user = await requireUser();
  const { splatId } = await ctx.params;
  requireUuid(splatId, 404, "Splat not found");

  // Scoped by userId, and a miss is a 404 rather than a 403 — someone else's splat is indistinguishable from a
  // nonexistent one.
  const [splat] = await getDb()
    .select(splatColumns)
    .from(splats)
    .where(and(eq(splats.id, splatId), eq(splats.userId, user.id)))
    .limit(1);
  if (splat === undefined) {
    throw new HttpError(404, "Splat not found");
  }
  return NextResponse.json(splat);
});

/**
 * Deletes the splat, its photos and jobs (both cascade from the splat row), and everything it stored in S3, stopping
 * any worker still running for it first.
 *
 * The row goes before the S3 objects. A failed S3 cleanup then leaves orphaned objects nothing points at, rather than a
 * splat whose photos and results have vanished from under it.
 */
export const DELETE = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]">) => {
    const user = await requireUser();
    const { splatId } = await ctx.params;
    requireUuid(splatId, 404, "Splat not found");

    const [splat] = await getDb()
      .select({ id: splats.id })
      .from(splats)
      .where(and(eq(splats.id, splatId), eq(splats.userId, user.id)))
      .limit(1);
    if (splat === undefined) {
      throw new HttpError(404, "Splat not found");
    }

    await cancelActiveJob(splatId);
    await getDb().delete(splats).where(eq(splats.id, splatId));
    try {
      await deleteSplatObjects(splatId);
    } catch (err) {
      console.error(`Deleted splat ${splatId} but not all of its S3 objects`, err);
    }
    return new NextResponse(null, { status: 204 });
  },
);
