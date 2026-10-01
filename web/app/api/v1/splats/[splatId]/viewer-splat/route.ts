/**
 * GET /api/v1/splats/[splatId]/viewer-splat: a link to the splat the 3D viewer loads.
 *
 * Returns a presigned URL (a time-limited S3 link) for the compressed .spz copy of the finished splat, which loads far
 * faster than the lossless .ply the download route serves.
 */

import { and, desc, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { jobs, splats } from "@/lib/server/db/schema";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { presignSplatDownload } from "@/lib/server/s3";
import { JobStatus } from "@/lib/statuses";

export const GET = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/viewer-splat">) => {
    const user = await requireUser();
    const { splatId } = await ctx.params;
    requireUuid(splatId, 404, "Splat not ready");

    // This is the compressed .spz the 3D viewer loads. The Download button's lossless .ply comes from
    // web/app/api/v1/splats/[splatId]/download/route.ts. Both deliberately collapse "not ready" and "not yours" into
    // the same 404.
    const [latestJob] = await getDb()
      .select({ resultSpzS3Key: jobs.resultSpzS3Key })
      .from(jobs)
      .innerJoin(splats, eq(splats.id, jobs.splatId))
      .where(
        and(
          eq(jobs.splatId, splatId),
          eq(jobs.status, JobStatus.complete),
          eq(splats.userId, user.id),
          eq(splats.status, "complete"),
        ),
      )
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    if (latestJob === undefined || latestJob.resultSpzS3Key === null) {
      throw new HttpError(404, "Splat not ready");
    }

    return NextResponse.json(await presignSplatDownload(latestJob.resultSpzS3Key));
  },
);
