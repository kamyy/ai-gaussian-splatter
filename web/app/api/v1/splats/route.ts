import { and, desc, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

import { requireUser } from "@/lib/server/auth";
import { getDb } from "@/lib/server/db";
import { jobs, photos, splats } from "@/lib/server/db/schema";
import { HttpError, withErrorHandling } from "@/lib/server/httpError";
import { presignPhotoDownload } from "@/lib/server/s3";
import { jobColumns, photoColumns, splatColumns } from "@/lib/server/selects";

const schema = z.object({
  name: z.string().min(1),
});

export const POST = withErrorHandling(async (req: Request) => {
  const user = await requireUser();

  const { success, data } = schema.safeParse(await req.json().catch(() => null));
  if (!success) {
    throw new HttpError(422, "Invalid request body");
  }

  const [splat] = await getDb()
    .insert(splats)
    .values({
      userId: user.id,
      name: data.name,
    })
    .returning(splatColumns);

  return NextResponse.json(splat, {
    status: 201,
  });
});

// Batched, not one query per splat: two extra queries scoped with inArray() over every id in the list, then reduced
// in JS to one row per splat, rather than an N+1 fan-out or a DISTINCT ON/lateral-join query. Job/photo rows are
// already scoped to this user because their splatId is drawn from the splats query above, which already filtered on
// userId — no extra ownership join needed.
export const GET = withErrorHandling(async () => {
  const user = await requireUser();

  const rows = await getDb()
    .select(splatColumns)
    .from(splats)
    .where(eq(splats.userId, user.id))
    .orderBy(desc(splats.createdAt));

  if (rows.length === 0) {
    return NextResponse.json([]);
  }
  const ids = rows.map(row => row.id);

  // Neither query depends on the other's result, so they run in parallel rather than as two sequential round trips.
  const [photoRows, jobRows] = await Promise.all([
    // Ordered oldest-first per splat, then the loop below keeps only the first row it sees per id — the thumbnail
    // source is the first photo uploaded, not the most recent.
    getDb()
      .select(photoColumns)
      .from(photos)
      .where(and(inArray(photos.splatId, ids), eq(photos.uploadStatus, "uploaded")))
      .orderBy(photos.splatId, photos.createdAt),
    // Ordered newest-first per splat so the loop's "keep the first seen" reduction picks the latest job, matching
    // web/app/api/v1/splats/[splatId]/jobs/latest/route.ts's single-splat query.
    getDb().select(jobColumns).from(jobs).where(inArray(jobs.splatId, ids)).orderBy(jobs.splatId, desc(jobs.createdAt)),
  ]);

  // hasUploadedPhotos is answered by this same map (has() finds a row iff at least one "uploaded" photo exists for
  // that splat) rather than a separate grouped-count query — the two would otherwise need to stay consistent by hand.
  const firstPhotoBySplat = new Map<string, (typeof photoRows)[number]>();
  for (const row of photoRows) {
    if (!firstPhotoBySplat.has(row.splatId)) {
      firstPhotoBySplat.set(row.splatId, row);
    }
  }

  const latestJobBySplat = new Map<string, (typeof jobRows)[number]>();
  for (const row of jobRows) {
    if (!latestJobBySplat.has(row.splatId)) {
      latestJobBySplat.set(row.splatId, row);
    }
  }

  const result = await Promise.all(
    rows.map(async splat => {
      const latestJob = latestJobBySplat.get(splat.id);
      const firstPhoto = firstPhotoBySplat.get(splat.id);
      return {
        ...splat,
        hasUploadedPhotos: firstPhotoBySplat.has(splat.id),
        hasPointCloud: latestJob?.pointCloudS3Key != null,
        hasTrainedSplat: latestJob?.resultS3Key != null,
        thumbnailPhotoUrl: firstPhoto ? await presignPhotoDownload(firstPhoto.s3Key) : null,
      };
    }),
  );

  return NextResponse.json(result);
});
