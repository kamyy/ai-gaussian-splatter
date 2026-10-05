/**
 * Looks up the worker job behind a user's finished splat, for the owner's routes that serve or crop its result.
 *
 * A splat can have several jobs, and the newest complete one is the one its download, viewers and share page serve.
 * Cropping and undoing a crop act on that same job. Each owner route reads it from here, so they all agree on which
 * job that is.
 */

import { and, desc, eq } from "drizzle-orm";

import { JobStatus, SplatStatus } from "@/lib/statuses";
import { getDb } from "./db";
import { type Job, jobs, splats } from "./db/schema";
import { HttpError, requireUuid } from "./httpError";

/** A complete job, which always has both of the worker's result files. */
type FinishedJob = Job & { resultPlyS3Key: string; resultSpzS3Key: string };

/**
 * The newest complete job of a complete splat the user owns. "Not ready" and "not yours" collapse into one 404, as on
 * the download route.
 */
export async function requireFinishedJob(splatId: string, userId: string): Promise<FinishedJob> {
  requireUuid(splatId, 404, "Splat not ready");

  const [row] = await getDb()
    .select({ job: jobs })
    .from(jobs)
    .innerJoin(splats, eq(splats.id, jobs.splatId))
    .where(
      and(
        eq(jobs.splatId, splatId),
        eq(jobs.status, JobStatus.complete),
        eq(splats.userId, userId),
        eq(splats.status, SplatStatus.complete),
      ),
    )
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  if (row === undefined) {
    throw new HttpError(404, "Splat not ready");
  }

  const { resultPlyS3Key, resultSpzS3Key } = row.job;
  if (resultPlyS3Key === null || resultSpzS3Key === null) {
    throw new HttpError(404, "Splat not ready");
  }

  return { ...row.job, resultPlyS3Key, resultSpzS3Key };
}
