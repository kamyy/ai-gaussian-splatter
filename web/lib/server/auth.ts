/**
 * Who is calling an API route, and whether they're allowed to.
 *
 * requireUser() and requireClerkUserId() are how each authenticated Route Handler checks for a Clerk session.
 * requireUser() also creates the user's own database row on their first request, once Clerk confirms the user exists.
 * getJobForCallbackToken() checks the per-worker-job bearer token a worker instance sends in place of a Clerk session.
 * requireOwnedSplat() checks that a splat in the URL belongs to the caller. getClientIp() reads the caller's IP address
 * for rate limiting.
 */

import { auth, clerkClient } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { getDb } from "./db";
import { type Job, jobs, splats, type User, users } from "./db/schema";
import { HttpError, requireUuid } from "./httpError";

/** Throws 401 unless the request carries a valid Clerk session. */
export async function requireClerkUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) {
    throw new HttpError(401, "Missing bearer token");
  }

  return userId;
}

/**
 * Local shadow row for the Clerk user, created lazily on first request.
 *
 * One `INSERT ... ON CONFLICT`, so two concurrent first-requests from the same user can't race to create the same row.
 * The no-op `set` is deliberate: `onConflictDoNothing()` returns zero rows from `.returning()`, so an existing user
 * would come back `undefined`. The update has to touch something for Postgres to hand the row back.
 */
export async function getOrCreateUser(clerkUserId: string): Promise<User> {
  const [user] = await getDb()
    .insert(users)
    .values({ clerkUserId })
    .onConflictDoUpdate({ target: users.clerkUserId, set: { clerkUserId } })
    .returning();
  return user;
}

/** Whether an error from Clerk's Backend API means the user it names doesn't exist. */
export function isClerkNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "status" in err && err.status === 404;
}

/**
 * The authenticated caller's local User row, or 401.
 *
 * A row is only created once Clerk confirms the user still exists. A session token stays valid for up to a minute
 * after DELETE /api/v1/account deletes the Clerk user, because it is checked without asking Clerk. Without this check,
 * a request from another open tab in that minute would create an empty row for the deleted account. The check costs a
 * Clerk API call on a user's first request only. Every later request finds the row with one select.
 */
export async function requireUser(): Promise<User> {
  const clerkUserId = await requireClerkUserId();

  const [user] = await getDb().select().from(users).where(eq(users.clerkUserId, clerkUserId)).limit(1);
  if (user !== undefined) {
    return user;
  }

  try {
    await (await clerkClient()).users.getUser(clerkUserId);
  } catch (err) {
    if (isClerkNotFound(err)) {
      throw new HttpError(401, "This account has been deleted");
    }

    throw err;
  }

  return getOrCreateUser(clerkUserId);
}

/**
 * Throws 404 unless the id is a valid UUID naming a splat the user owns. Someone else's splat gets the same 404 as one
 * that doesn't exist, so the API never confirms that an id is in use.
 */
export async function requireOwnedSplat(splatId: string, userId: string): Promise<void> {
  requireUuid(splatId, 404, "Splat not found");

  const [splat] = await getDb()
    .select({ id: splats.id })
    .from(splats)
    .where(and(eq(splats.id, splatId), eq(splats.userId, userId)))
    .limit(1);
  if (splat === undefined) {
    throw new HttpError(404, "Splat not found");
  }
}

/**
 * The client IP the per-IP rate limit is keyed on, from the LAST hop of `X-Forwarded-For`. The ALB appends the address
 * it actually saw rather than replacing the header, so a spoofed `X-Forwarded-For: 1.2.3.4` arrives as `1.2.3.4, <real
 * client>`. Trusting the first entry would let a caller mint a fresh rate-limit bucket per request just by varying it.
 * This assumes exactly one trusted proxy. Putting anything in front of the ALB moves the trustworthy position and
 * breaks it (ARCHITECTURE.md).
 *
 * `NextRequest` has no socket address to fall back to: unproxied local requests all share the "unknown" bucket.
 */
export function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers.get("X-Forwarded-For");
  if (forwardedFor) {
    const hops = forwardedFor
      .split(",")
      .map(hop => hop.trim())
      .filter(hop => hop.length > 0);
    if (hops.length > 0) {
      return hops[hops.length - 1];
    }
  }

  return "unknown";
}

/**
 * Auth for the worker's status callback and for the S3 credentials route. It compares a random per-worker-job token
 * against the worker job's own `callbackToken` column instead of checking a Clerk session. A compromised instance can
 * update that worker job's status, and can read and write that splat's S3 objects.
 */
export async function getJobForCallbackToken(jobId: string, request: NextRequest): Promise<Job> {
  const authHeader = request.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    throw new HttpError(401, "Missing bearer token");
  }

  const token = authHeader.slice("Bearer ".length).trim();

  // 401 rather than 404 for a malformed id, so this can't be used to probe which job ids exist. An unknown job id is
  // 401 below for the same reason.
  requireUuid(jobId, 401, "Invalid job token");

  const [job] = await getDb().select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (job === undefined || job.callbackToken !== token) {
    throw new HttpError(401, "Invalid job token");
  }

  return job;
}
