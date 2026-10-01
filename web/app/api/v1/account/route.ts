/**
 * DELETE /api/v1/account: deletes the signed-in user's account and everything in it.
 *
 * The account menu's Delete account dialog calls this. It stops any worker still running for the user, deletes their
 * database rows and their splats' S3 objects, and finally deletes the user from Clerk. Clerk's own self-delete is
 * switched off, because nothing would remove the app's data if a user were deleted there.
 */

import { clerkClient } from "@clerk/nextjs/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { isClerkNotFound, requireClerkUserId } from "@/lib/server/auth";
import { WORKER_RUNNING_STATUSES } from "@/lib/server/cancelJob";
import { getDb } from "@/lib/server/db";
import { jobs, rateLimitCounters, splats, users } from "@/lib/server/db/schema";
import { localLaunchEnabled, stopLocalWorker, terminateWorker } from "@/lib/server/ec2Launcher";
import { withErrorHandling } from "@/lib/server/httpError";
import { userRateLimitScope } from "@/lib/server/rateLimit";
import { deleteSplatObjects } from "@/lib/server/s3";

/**
 * Stops every worker still running for the user's splats. It runs before any row is deleted, so a worker that can't be
 * stopped fails the request while the account is still whole and can be retried.
 */
async function stopWorkers(running: { jobId: string; ec2InstanceId: string | null }[]): Promise<void> {
  if (localLaunchEnabled()) {
    for (const { jobId } of running) {
      stopLocalWorker(jobId);
    }

    return;
  }

  await Promise.all(running.flatMap(({ ec2InstanceId }) => (ec2InstanceId ? [terminateWorker(ec2InstanceId)] : [])));
}

/**
 * Deletes the user's Clerk account. Clerk's 404 means an earlier attempt already deleted it, so a retry still
 * succeeds.
 */
async function deleteClerkUser(clerkUserId: string): Promise<void> {
  try {
    await (await clerkClient()).users.deleteUser(clerkUserId);
  } catch (err) {
    if (isClerkNotFound(err)) {
      return;
    }

    throw err;
  }
}

/**
 * Postgres sees three statements, however many splats the user has. One read finds the user's splats and running
 * workers. One delete removes the user row, which cascades to their splats and from there to photos and jobs, and
 * removes their rate-limit counter in the same statement. A last delete runs after Clerk's.
 *
 * The rows go before the S3 objects, so a failed S3 cleanup leaves orphaned objects rather than an account pointing at
 * missing files. The Clerk user goes after the rows. A failure there leaves a signed-in user with no data, and retrying
 * finishes the deletion.
 *
 * The session token still works until Clerk deletes the user. A request from another open tab in that gap goes
 * through requireUser(), which creates the user row again because Clerk still has the user. The last delete removes
 * that row. After Clerk's delete, requireUser() refuses to create one.
 */
export const DELETE = withErrorHandling(async () => {
  const clerkUserId = await requireClerkUserId();

  const rows = await getDb()
    .select({ userId: users.id, splatId: splats.id, jobId: jobs.id, ec2InstanceId: jobs.ec2InstanceId })
    .from(users)
    .leftJoin(splats, eq(splats.userId, users.id))
    .leftJoin(jobs, and(eq(jobs.splatId, splats.id), inArray(jobs.status, WORKER_RUNNING_STATUSES)))
    .where(eq(users.clerkUserId, clerkUserId));

  if (rows.length > 0) {
    const userId = rows[0].userId;
    const splatIds = rows.flatMap(row => (row.splatId ? [row.splatId] : []));
    const running = rows.flatMap(row => (row.jobId ? [{ jobId: row.jobId, ec2InstanceId: row.ec2InstanceId }] : []));

    await stopWorkers(running);

    await getDb().execute(sql`
      with deleted_counters as (
        delete from ${rateLimitCounters} where ${rateLimitCounters.scope} = ${userRateLimitScope(userId)}
      )
      delete from ${users} where ${users.id} = ${userId}`);

    const results = await Promise.allSettled(splatIds.map(splatId => deleteSplatObjects(splatId)));
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        console.error(`Deleted splat ${splatIds[i]} but not all of its S3 objects`, result.reason);
      }
    });
  }

  await deleteClerkUser(clerkUserId);
  await getDb().delete(users).where(eq(users.clerkUserId, clerkUserId));

  return new NextResponse(null, { status: 204 });
});
