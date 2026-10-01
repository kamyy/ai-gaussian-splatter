/**
 * POST /api/v1/splats/[splatId]/cancel: stop the splat's running worker job.
 *
 * Terminates the GPU instance working on the splat and marks its job cancelled. The splat keeps its photos, so
 * processing can be started again.
 */

import { type NextRequest, NextResponse } from "next/server";

import { requireOwnedSplat, requireUser } from "@/lib/server/auth";
import { cancelActiveJob } from "@/lib/server/cancelJob";
import { HttpError, withErrorHandling } from "@/lib/server/httpError";

export const POST = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/cancel">) => {
    const user = await requireUser();
    const { splatId } = await ctx.params;
    await requireOwnedSplat(splatId, user.id);

    const job = await cancelActiveJob(splatId);
    if (job === undefined) {
      throw new HttpError(409, "Nothing is running for this splat");
    }

    return NextResponse.json(job);
  },
);
