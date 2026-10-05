/**
 * GET /api/v1/splats/[splatId]/viewer-splat: a link to the splat the 3D viewer loads.
 *
 * Returns a presigned URL (a time-limited S3 link) for the compressed .spz copy of the finished splat, which loads far
 * faster than the lossless .ply the download route serves. Once the owner has cropped the splat, that is the cropped
 * copy.
 */

import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { requireFinishedJob } from "@/lib/server/finishedJob";
import { withErrorHandling } from "@/lib/server/httpError";
import { presignSplatDownload } from "@/lib/server/s3";

export const GET = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/viewer-splat">) => {
    const user = await requireUser();
    const { splatId } = await ctx.params;
    const job = await requireFinishedJob(splatId, user.id);

    return NextResponse.json(await presignSplatDownload(job.croppedResultSpzS3Key ?? job.resultSpzS3Key));
  },
);
