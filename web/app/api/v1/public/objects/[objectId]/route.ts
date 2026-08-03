import { type NextRequest, NextResponse } from "next/server";

import { getPublicSplat } from "@/lib/server/data";
import { HttpError, withErrorHandling } from "@/lib/server/httpError";

export const GET = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/public/objects/[objectId]">) => {
    const { objectId } = await ctx.params;
    const splat = await getPublicSplat(objectId);
    // Non-shareable and incomplete splats 404 identically to nonexistent ones,
    // so this endpoint can't be used to probe which IDs are real.
    if (splat === null) {
      throw new HttpError(404, "Not found");
    }
    return NextResponse.json(splat);
  },
);
