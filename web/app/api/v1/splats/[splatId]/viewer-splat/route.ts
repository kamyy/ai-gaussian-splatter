import { and, desc, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { jobs, splats } from "@/lib/server/db/schema";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { presignSplatDownload } from "@/lib/server/s3";

export const GET = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/viewer-splat">) => {
    const user = await requireUser();
    const { splatId } = await ctx.params;
    requireUuid(splatId, 404, "Splat not ready");

    // This is the compressed .spz the 3D viewer loads. The Download button's lossless .ply comes from
    // web/app/api/v1/splats/[splatId]/download/route.ts. Both deliberately collapse "not ready" and "not yours" into
    // the same 404.
    const [splat] = await getDb()
      .select()
      .from(splats)
      .where(and(eq(splats.id, splatId), eq(splats.userId, user.id), eq(splats.status, "complete")))
      .limit(1);
    if (splat === undefined) {
      throw new HttpError(404, "Splat not ready");
    }

    const [latestJob] = await getDb()
      .select()
      .from(jobs)
      .where(and(eq(jobs.splatId, splatId), eq(jobs.status, "complete")))
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    if (latestJob === undefined || latestJob.resultSpzS3Key === null) {
      throw new HttpError(404, "Splat not ready");
    }

    return NextResponse.json(await presignSplatDownload(latestJob.resultSpzS3Key));
  },
);
