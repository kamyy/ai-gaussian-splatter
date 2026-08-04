import { and, desc, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { jobs, splats } from "@/lib/server/db/schema";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { presignSplatDownload } from "@/lib/server/s3";

export const GET = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/objects/[objectId]/splat">) => {
    const user = await requireUser();
    const { objectId } = await ctx.params;
    requireUuid(objectId, 404, "Splat not ready");

    // "Not ready" and "not yours" deliberately collapse to the same 404.
    const [splat] = await getDb()
      .select()
      .from(splats)
      .where(and(eq(splats.id, objectId), eq(splats.userId, user.id), eq(splats.status, "complete")))
      .limit(1);
    if (splat === undefined) {
      throw new HttpError(404, "Splat not ready");
    }

    const [latestJob] = await getDb()
      .select()
      .from(jobs)
      .where(and(eq(jobs.splatId, objectId), eq(jobs.status, "complete")))
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    if (latestJob === undefined || latestJob.resultS3Key === null) {
      throw new HttpError(404, "Splat not ready");
    }

    return NextResponse.json({ url: await presignSplatDownload(latestJob.resultS3Key) });
  },
);
