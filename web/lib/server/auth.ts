import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { getDb } from "./db";
import { type Job, jobs, type User, users } from "./db/schema";
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
 * Local shadow row per plan §2 — created lazily on first request.
 *
 * One `INSERT ... ON CONFLICT`, so two concurrent first-requests from the same
 * user can't race to create the same row. The no-op `set` is deliberate:
 * `onConflictDoNothing()` returns zero rows from `.returning()`, so an existing
 * user would come back `undefined` — the update has to touch something for
 * Postgres to hand the row back.
 */
export async function getOrCreateUser(clerkUserId: string): Promise<User> {
  const [user] = await getDb()
    .insert(users)
    .values({ clerkUserId })
    .onConflictDoUpdate({ target: users.clerkUserId, set: { clerkUserId } })
    .returning();
  return user;
}

/** The authenticated caller's local User row, or 401. */
export async function requireUser(): Promise<User> {
  return getOrCreateUser(await requireClerkUserId());
}

/**
 * The client IP the per-IP rate limit is keyed on (plan §5) — read from
 * X-Forwarded-For, which the ALB in front of this app always sets.
 *
 * Takes the LAST hop, not the first. An ALB *appends* the address it actually
 * saw to whatever the client sent, so with a spoofed
 * `X-Forwarded-For: 1.2.3.4` the header arrives as `1.2.3.4, <real client>`.
 * Trusting the first entry would let any caller mint a fresh rate-limit bucket
 * per request just by varying that header, defeating the multi-account defense
 * this exists to be. Only the entry the ALB itself appended is trustworthy.
 *
 * NOTE: this assumes exactly one trusted proxy. Putting CloudFront (or any
 * second proxy) in front of the ALB shifts the trustworthy position again —
 * the last hop would then be CloudFront's address, shared by every user. That
 * change requires revisiting this function, not just the infrastructure.
 *
 * NextRequest exposes no socket address, so there's no peer to fall back to.
 * Behind the ALB the header is always present; locally, unproxied requests all
 * share the "unknown" bucket.
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
 * Auth for the worker->this-app status callback (plan §3): a per-job signed
 * token, not a Clerk session, scoped so a compromised instance can only mutate
 * the one job it was launched for.
 */
export async function getJobForCallbackToken(jobId: string, request: NextRequest): Promise<Job> {
  const authHeader = request.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    throw new HttpError(401, "Missing bearer token");
  }
  const token = authHeader.slice("Bearer ".length).trim();

  // 401 rather than 404 for a malformed id, so this can't be used to probe
  // which job ids exist — same reason an unknown job id is 401 below.
  requireUuid(jobId, 401, "Invalid job token");

  const [job] = await getDb().select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (job === undefined || job.callbackToken !== token) {
    throw new HttpError(401, "Invalid job token");
  }
  return job;
}
