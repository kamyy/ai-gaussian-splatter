import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { getPrisma } from "@/lib/server/prisma";
import { jobReadSelect } from "@/lib/server/selects";

export const GET = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/objects/[objectId]/jobs/latest">) => {
    const user = await requireUser();
    const { objectId } = await ctx.params;
    requireUuid(objectId, 404, "No jobs for this object");

    const job = await getPrisma().job.findFirst({
      where: { splatId: objectId, splat: { userId: user.id } },
      orderBy: { createdAt: "desc" },
      select: jobReadSelect,
    });
    if (job === null) {
      throw new HttpError(404, "No jobs for this object");
    }
    return NextResponse.json(job);
  },
);
