import { randomUUID } from "node:crypto";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getClientIp, requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { type NewPhoto, photos, splats } from "@/lib/server/db/schema";
import { getEnv } from "@/lib/server/env";
import { HttpError, requireUuid, withErrorHandling } from "@/lib/server/httpError";
import { checkAndIncrementIp, checkAndIncrementUser } from "@/lib/server/rateLimit";
import { presignPhotoUpload } from "@/lib/server/s3";
import type { PhotoPresignItem } from "@/lib/types";

// Rate limiting happens here: it gates *before* any upload
// happens (per-IP + per-user), separate from the global daily cap which only
// gates the expensive job-launch step (../process).
const presignSchema = z.array(z.object({ filename: z.string().min(1), contentType: z.string().min(1) })).min(1);

export const POST = withErrorHandling(
  async (request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/photos/presign">) => {
    const env = getEnv();
    const user = await requireUser();
    const { splatId } = await ctx.params;
    requireUuid(splatId, 404, "Splat not found");

    const [splat] = await getDb()
      .select({ id: splats.id })
      .from(splats)
      .where(and(eq(splats.id, splatId), eq(splats.userId, user.id)))
      .limit(1);
    if (splat === undefined) {
      throw new HttpError(404, "Splat not found");
    }

    const parsed = presignSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(422, "Invalid request body");
    }

    // Both checks before any S3 URL is issued — the actual multi-account
    // defense (per-IP) plus the per-user quota.
    await checkAndIncrementIp(getClientIp(request), env.RATE_LIMIT_IP_PER_HOUR);
    await checkAndIncrementUser(user.id, env.RATE_LIMIT_USER_PER_DAY);

    const items: PhotoPresignItem[] = [];
    const rows: NewPhoto[] = [];
    for (const item of parsed.data) {
      const photoId = randomUUID();
      const extension = path.extname(item.filename) || ".jpg";
      const { key, url } = await presignPhotoUpload(splatId, photoId, extension, item.contentType);

      rows.push({
        id: photoId,
        splatId,
        s3Key: key,
        originalFilename: item.filename,
        contentType: item.contentType,
        uploadStatus: "pending",
      });
      items.push({ photoId, presignedPutUrl: url, s3Key: key });
    }

    // One insert, not one per photo: a mid-loop failure would otherwise leave a
    // partial batch of pending rows behind, with the caller holding no ids to
    // retry against and the rate-limit increment already spent.
    await getDb().insert(photos).values(rows);

    return NextResponse.json({ photos: items });
  },
);
