/**
 * GET /api/v1/splats/[splatId]/download: a download link for the finished splat.
 *
 * Returns a presigned URL (a time-limited link straight to the file in S3, AWS's file storage) for the lossless .ply
 * file the Download button saves. The 3D viewer loads a smaller compressed copy from the viewer-splat route instead.
 * Once the owner has cropped the splat, both serve the cropped copy (web/app/api/v1/splats/[splatId]/crop/route.ts).
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
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/download">) => {
    const user = await requireUser();
    const { splatId } = await ctx.params;
    requireUuid(splatId, 404, "Splat not ready");

    // "Not ready" and "not yours" deliberately collapse to the same 404.
    const [latestJob] = await getDb()
      .select({ resultPlyS3Key: jobs.resultPlyS3Key, croppedResultPlyS3Key: jobs.croppedResultPlyS3Key })
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
    if (latestJob === undefined || latestJob.resultPlyS3Key === null) {
      throw new HttpError(404, "Splat not ready");
    }

    return NextResponse.json(await presignSplatDownload(latestJob.croppedResultPlyS3Key ?? latestJob.resultPlyS3Key));
  },
);
