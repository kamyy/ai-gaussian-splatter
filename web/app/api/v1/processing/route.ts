/**
 * GET /api/v1/processing: whether GPU processing is switched on for the whole site.
 *
 * The new-splat form and the splat page's Start and Build cards read this so they can warn that processing is paused
 * before anyone uploads or clicks. It reports the same processing-enabled runtime setting that the process and train
 * routes enforce (web/lib/server/runtimeSettings.ts), so a setting that can't be read reports paused here too.
 */

import { NextResponse } from "next/server";

import { requireClerkUserId } from "@/lib/server/auth";
import { withErrorHandling } from "@/lib/server/httpError";
import { getRuntimeSettings } from "@/lib/server/runtimeSettings";
import type { ProcessingStatus } from "@/lib/types";

export const GET = withErrorHandling(async () => {
  await requireClerkUserId();

  const { processingEnabled } = await getRuntimeSettings();
  const status: ProcessingStatus = { enabled: processingEnabled };

  return NextResponse.json(status);
});
