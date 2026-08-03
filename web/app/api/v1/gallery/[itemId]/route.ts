import { type NextRequest, NextResponse } from "next/server";

import { getGalleryItem } from "@/lib/server/data";
import { HttpError, withErrorHandling } from "@/lib/server/httpError";

export const GET = withErrorHandling(async (_request: NextRequest, ctx: RouteContext<"/api/v1/gallery/[itemId]">) => {
  const { itemId } = await ctx.params;
  const item = await getGalleryItem(itemId);
  if (item === null) {
    throw new HttpError(404, "Gallery item not found");
  }
  return NextResponse.json(item);
});
