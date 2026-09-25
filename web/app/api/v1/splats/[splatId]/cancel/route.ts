import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { cancelActiveJob } from "@/lib/server/cancelJob";
import { getDb } from "@/lib/server/db";
import { splats } from "@/lib/server/db/schema";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";

/** Stops the splat's running worker job. The splat keeps its photos, so processing can be started again. */
export const POST = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/cancel">) => {
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

    const job = await cancelActiveJob(splatId);
    if (job === undefined) {
      throw new HttpError(409, "Nothing is running for this splat");
    }
    return NextResponse.json(job);
  },
);
