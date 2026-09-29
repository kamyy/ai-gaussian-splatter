/**
 * GET /api/v1/splats/[splatId]/cameras: where each photo was taken from.
 *
 * Returns the camera positions and orientations COLMAP (the structure-from-motion tool in worker/) worked out for the
 * splat's photos, keyed by photo id. The 3D viewer draws them as small pyramids and flies the view to one when its
 * photo is picked. They exist once the reconstruct stage has run.
 */

import { and, eq, isNotNull } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { jobs, splats } from "@/lib/server/db/schema";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { readSplatCameras } from "@/lib/server/s3";

/**
 * Returns the poses themselves rather than a presigned URL, since they're a few kilobytes and the server has to map
 * the worker's photo filenames back to photo ids anyway.
 */
export const GET = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/cameras">) => {
    const user = await requireUser();
    const { splatId } = await ctx.params;
    requireUuid(splatId, 404, "Cameras not ready");

    // "Not ready" and "not yours" collapse to the same 404, as in the point-cloud route beside this one. The cameras
    // are written in the same step as the point cloud, so a job with a point cloud key is the gate.
    const [row] = await getDb()
      .select({ id: jobs.id })
      .from(jobs)
      .innerJoin(splats, eq(splats.id, jobs.splatId))
      .where(and(eq(jobs.splatId, splatId), eq(splats.userId, user.id), isNotNull(jobs.pointCloudS3Key)))
      .limit(1);
    if (row === undefined) {
      throw new HttpError(404, "Cameras not ready");
    }

    const cameras = await readSplatCameras(splatId);
    if (cameras === null) {
      throw new HttpError(404, "Cameras not ready");
    }

    return NextResponse.json(cameras);
  },
);
