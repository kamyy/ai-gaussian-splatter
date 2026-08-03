import { auth } from "@clerk/nextjs/server";
import type { Job, User } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";

import { HttpError, requireUuid } from "./httpError";
import { getPrisma } from "./prisma";

/** Throws 401 unless the request carries a valid Clerk session. */
export async function requireClerkUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) {
    throw new HttpError(401, "Missing bearer token");
  }
  return userId;
}

/** Local shadow row per plan §2 — created lazily on first request. */
export async function getOrCreateUser(clerkUserId: string): Promise<User> {
  const prisma = getPrisma();

  const existing = await prisma.user.findUnique({ where: { clerkUserId } });
  if (existing !== null) {
    return existing;
  }

  try {
    return await prisma.user.create({ data: { clerkUserId } });
  } catch (error) {
    // Two concurrent first-requests from the same user race here. The loser
    // hits the unique constraint and simply re-reads the winner's row.
    // (Prisma's upsert() is not usable as a fix — it runs SELECT-then-INSERT,
    // so it has this same race rather than closing it.)
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return prisma.user.findUniqueOrThrow({ where: { clerkUserId } });
    }
    throw error;
  }
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

  const job = await getPrisma().job.findUnique({ where: { id: jobId } });
  if (job === null || job.callbackToken !== token) {
    throw new HttpError(401, "Invalid job token");
  }
  return job;
}
