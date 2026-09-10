import { and, desc, eq, isNotNull } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { jobs, splats } from "@/lib/server/db/schema";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { presignSplatDownload } from "@/lib/server/s3";

export const GET = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/point-cloud">) => {
    const user = await requireUser();
    const { splatId } = await ctx.params;
    requireUuid(splatId, 404, "Point cloud not ready");

    // "Not ready" and "not yours" deliberately collapse to the same 404, matching
    // web/app/api/v1/splats/[splatId]/download/route.ts. Gated on
    // colmapPointCloudS3Key rather than jobs.status: the reconstruct phase sets this key once and never clears it, so
    // the COLMAP point cloud stays viewable through training and after the splat completes.
    const [splat] = await getDb()
      .select({ id: splats.id })
      .from(splats)
      .where(and(eq(splats.id, splatId), eq(splats.userId, user.id)))
      .limit(1);
    if (splat === undefined) {
      throw new HttpError(404, "Point cloud not ready");
    }

    const [latestJob] = await getDb()
      .select()
      .from(jobs)
      .where(and(eq(jobs.splatId, splatId), isNotNull(jobs.colmapPointCloudS3Key)))
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    if (latestJob === undefined || latestJob.colmapPointCloudS3Key === null) {
      throw new HttpError(404, "Point cloud not ready");
    }

    return NextResponse.json(await presignSplatDownload(latestJob.colmapPointCloudS3Key));
  },
);
