/**
 * POST and DELETE /api/v1/splats/[splatId]/crop: crop a finished splat to a box, or undo the crop.
 *
 * The 3D viewer's Apply crop button posts the box. web/lib/server/cropSplat.ts writes cropped copies of the splat's
 * .ply and .spz beside the worker's originals, and the job row starts naming them. From then on the download, the
 * owner's viewer and the share page all serve the cropped copies. Undo crop (DELETE) points them all back at the
 * originals, which a crop never modifies. A new crop always starts from the originals, so crops never stack.
 *
 * Each crop is written under a fresh id rather than over the last one, so a viewer partway through downloading the
 * previous crop never reads a half-replaced file. The previous crop's objects are deleted once nothing names them.
 *
 * One user runs one crop at a time. The request claims the job first, and a second crop for that user is refused while
 * the claim is held. The row update matches only while that claim and the cropped keys it started from are still in
 * place, so an undo that lands during the stream wins and this crop does not. The hourly limit is counted only after
 * that update commits. The claim is cleared in the same update. The claim and the release that drops an uncommitted one
 * are raw updates, so updatedAt, which the viewer uses as its reload key, moves only when a crop or an undo commits.
 *
 * Once a crop or an undo commits, it has applied. A step after that, such as counting the crop or deleting the
 * replaced objects, logs its failure rather than returning one.
 */

import { randomUUID } from "node:crypto";

import { and, eq, gt, isNotNull, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { cropSplatFiles } from "@/lib/server/cropSplat";
import { getDb } from "@/lib/server/db";
import { type Job, jobs, splats } from "@/lib/server/db/schema";
import { requireFinishedJob } from "@/lib/server/finishedJob";
import { HttpError, parseJsonBody, withErrorHandling } from "@/lib/server/httpError";
import { assertUserCropCapacity, checkAndIncrementUserCrops } from "@/lib/server/rateLimit";
import { deleteSplatsBucketObjects, splatCropS3Keys } from "@/lib/server/s3";
import { jobColumns } from "@/lib/server/selects";
import { JobStatus } from "@/lib/statuses";

// infra/locals.tf's alb_idle_timeout_seconds, in milliseconds. The crop writes no response bytes until it finishes,
// so the load balancer closes the request after this long with nothing sent. A claim older than that belongs to a
// request that can no longer commit.
const CROP_DEADLINE_MS = 300_000;

const cropSchema = z.object({
  box: z.object({
    center: z.tuple([z.number(), z.number(), z.number()]),
    size: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
    quaternion: z
      .tuple([z.number(), z.number(), z.number(), z.number()])
      .refine(quaternion => Math.hypot(...quaternion) > 1e-6, "A rotation quaternion can't be zero"),
  }),
});

/** The objects a job's current crop is stored in, or none when it isn't cropped. */
function cropObjectKeys(job: Pick<Job, "croppedResultPlyS3Key" | "croppedResultSpzS3Key">): string[] {
  if (job.croppedResultPlyS3Key === null || job.croppedResultSpzS3Key === null) {
    return [];
  }

  return [job.croppedResultPlyS3Key, job.croppedResultSpzS3Key];
}

/** Matches a cropped key, including the uncropped case where the column is null. */
function sameCropKey(
  column: typeof jobs.croppedResultPlyS3Key | typeof jobs.croppedResultSpzS3Key,
  value: string | null,
): SQL {
  return value === null ? isNull(column) : eq(column, value);
}

/**
 * Points the job at a crop, or at no crop when crop is null. The share preview stays the thumbnail the worker
 * rendered, and the library card stays the first photo.
 *
 * The update matches only while the cropped keys are still the ones job was read with. claimedAt, when set, also
 * requires this request's claim. Returns undefined when either has moved on.
 */
async function setCrop(
  job: Job,
  crop: { box: Job["cropBox"]; ply: string; spz: string } | null,
  claimedAt: Date | null,
): Promise<Partial<Job> | undefined> {
  const matches = [
    eq(jobs.id, job.id),
    eq(jobs.status, JobStatus.complete),
    sameCropKey(jobs.croppedResultPlyS3Key, job.croppedResultPlyS3Key),
    sameCropKey(jobs.croppedResultSpzS3Key, job.croppedResultSpzS3Key),
  ];
  if (claimedAt !== null) {
    matches.push(eq(jobs.cropStartedAt, claimedAt));
  }

  const [updated] = await getDb()
    .update(jobs)
    .set({
      cropBox: crop?.box ?? null,
      croppedResultPlyS3Key: crop?.ply ?? null,
      croppedResultSpzS3Key: crop?.spz ?? null,
      // Cleared in the same statement, so an undo that changes nothing else still beats an in-flight crop.
      cropStartedAt: null,
    })
    .where(and(...matches))
    .returning(jobColumns);

  return updated;
}

/**
 * Records that this user has a crop in flight, and returns the timestamp that marks it. A second crop for the same
 * user gets a 409. The user row lock makes the check and the write one step. The write is raw SQL, so it does not
 * move updatedAt.
 */
async function claimCrop(userId: string, job: Job): Promise<Date> {
  const staleBefore = new Date(Date.now() - CROP_DEADLINE_MS);
  const claimedAt = new Date();

  return getDb().transaction(async (tx): Promise<Date> => {
    await tx.execute(sql`select id from users where id = ${userId} for update`);

    const [busy] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .innerJoin(splats, eq(splats.id, jobs.splatId))
      .where(and(eq(splats.userId, userId), isNotNull(jobs.cropStartedAt), gt(jobs.cropStartedAt, staleBefore)))
      .limit(1);
    if (busy !== undefined) {
      throw new HttpError(409, "A crop is already running. Wait for it to finish.");
    }

    // The timestamp comes back from the row, so the later match uses the value Postgres stored.
    const claimed = await tx.execute<{ crop_started_at: string }>(sql`
      update ${jobs}
      set crop_started_at = ${claimedAt.toISOString()}
      where ${and(
        eq(jobs.id, job.id),
        eq(jobs.status, JobStatus.complete),
        sameCropKey(jobs.croppedResultPlyS3Key, job.croppedResultPlyS3Key),
        sameCropKey(jobs.croppedResultSpzS3Key, job.croppedResultSpzS3Key),
        or(isNull(jobs.cropStartedAt), lte(jobs.cropStartedAt, staleBefore)),
      )}
      returning crop_started_at
    `);
    const storedAt = claimed.rows[0]?.crop_started_at;
    if (storedAt === undefined) {
      throw new HttpError(409, "The splat changed while it was being cropped");
    }

    return new Date(storedAt);
  });
}

/** Drops a claim this request still holds. A raw update, so it leaves updatedAt where it is. */
async function releaseCrop(jobId: string, claimedAt: Date): Promise<void> {
  await getDb().execute(
    sql`update jobs set crop_started_at = null where id = ${jobId} and crop_started_at = ${claimedAt}`,
  );
}

/** Runs a step that follows a committed crop or undo, logging its failure instead of throwing it. */
async function afterCommit(step: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    console.error(`The crop change committed, but couldn't ${step}`, err);
  }
}

export const POST = withErrorHandling(
  async (request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/crop">) => {
    const user = await requireUser();
    const { splatId } = await ctx.params;
    const job = await requireFinishedJob(splatId, user.id);
    const { box } = await parseJsonBody(request, cropSchema);
    const claimedAt = await claimCrop(user.id, job);
    const target = splatCropS3Keys(splatId, randomUUID());

    let updated: Partial<Job> | undefined;
    try {
      await assertUserCropCapacity(user.id);
      await cropSplatFiles({ ply: job.resultPlyS3Key, spz: job.resultSpzS3Key }, target, box, request.signal);
      updated = await setCrop(job, { box, ply: target.ply, spz: target.spz }, claimedAt);
      if (updated === undefined) {
        throw new HttpError(409, "The splat changed while it was being cropped");
      }
    } catch (err) {
      // The crop didn't commit, so its objects are deleted and its claim released. A committed crop's update clears
      // the claim itself. Each cleanup logs its failure, so the caller sees the error that stopped the crop.
      await deleteSplatsBucketObjects([target.ply, target.spz]).catch(deleteErr => {
        console.error("Couldn't delete the crop that didn't commit", deleteErr);
      });
      await releaseCrop(job.id, claimedAt).catch(releaseErr => {
        console.error("Couldn't release the claim of the crop that didn't commit", releaseErr);
      });

      throw err;
    }

    await afterCommit("count it", () => checkAndIncrementUserCrops(user.id));
    await afterCommit("delete the replaced crop's objects", () => deleteSplatsBucketObjects(cropObjectKeys(job)));

    return NextResponse.json(updated);
  },
);

export const DELETE = withErrorHandling(
  async (_request: NextRequest, ctx: RouteContext<"/api/v1/splats/[splatId]/crop">) => {
    const user = await requireUser();
    const { splatId } = await ctx.params;
    const job = await requireFinishedJob(splatId, user.id);

    const updated = await setCrop(job, null, null);
    if (updated === undefined) {
      throw new HttpError(409, "The splat changed while its crop was being undone");
    }

    await afterCommit("delete the undone crop's objects", () => deleteSplatsBucketObjects(cropObjectKeys(job)));

    return NextResponse.json(updated);
  },
);
