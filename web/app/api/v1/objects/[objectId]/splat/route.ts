import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { getPrisma } from "@/lib/server/prisma";
import { presignSplatDownload } from "@/lib/server/s3";

export const GET = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/objects/[objectId]/splat">) => {
    const user = await requireUser();
    const { objectId } = await ctx.params;
    requireUuid(objectId, 404, "Splat not ready");

    // "Not ready" and "not yours" deliberately collapse to the same 404.
    const splat = await getPrisma().splat.findFirst({
      where: { id: objectId, userId: user.id, status: "Complete" },
    });
    if (splat === null) {
      throw new HttpError(404, "Splat not ready");
    }

    const latestJob = await getPrisma().job.findFirst({
      where: { splatId: objectId, status: "Complete" },
      orderBy: { createdAt: "desc" },
    });
    if (latestJob === null || latestJob.resultS3Key === null) {
      throw new HttpError(404, "Splat not ready");
    }

    return NextResponse.json({ url: await presignSplatDownload(latestJob.resultS3Key) });
  },
);
