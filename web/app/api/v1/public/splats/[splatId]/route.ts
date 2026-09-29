/**
 * GET /api/v1/public/splats/[splatId]: a shared splat, readable without signing in.
 *
 * Returns a splat's public details only when its owner has made it shareable and it has finished processing. This route
 * deliberately doesn't call requireUser(), which is what makes it public.
 */

import { type NextRequest, NextResponse } from "next/server";

import { getPublicSplat } from "@/lib/server/data";
import { HttpError, withErrorHandling } from "@/lib/server/httpError";

export const GET = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/public/splats/[splatId]">) => {
    const { splatId } = await ctx.params;
    const splat = await getPublicSplat(splatId);
    // Non-shareable and incomplete splats 404 identically to nonexistent ones, so this endpoint can't be used to probe
    // which IDs are real.
    if (splat === null) {
      throw new HttpError(404, "Not found");
    }
    return NextResponse.json(splat);
  },
);
