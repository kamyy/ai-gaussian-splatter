import { NextResponse } from "next/server";

import { listGallery } from "@/lib/server/data";
import { withErrorHandling } from "@/lib/server/httpError";

export const GET = withErrorHandling(async () => {
  return NextResponse.json(await listGallery());
});
