/**
 * GET /api/v1/splats/[splatId]/download: a download link for the finished splat.
 *
 * Returns a presigned URL (a time-limited link straight to the file in S3, AWS's file storage) for the lossless .ply
 * file the Download button saves. The 3D viewer loads a smaller compressed copy from the viewer-splat route instead.
 * Once the owner has cropped the splat, both serve the cropped copy (web/app/api/v1/splats/[splatId]/crop/route.ts).
 */

import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { requireFinishedJob } from "@/lib/server/finishedJob";
import { withErrorHandling } from "@/lib/server/httpError";
import { presignSplatDownload } from "@/lib/server/s3";

export const GET = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/download">) => {
    const user = await requireUser();
    const { splatId } = await ctx.params;
    const job = await requireFinishedJob(splatId, user.id);

    return NextResponse.json(await presignSplatDownload(job.croppedResultPlyS3Key ?? job.resultPlyS3Key));
  },
);
