import { sql } from "drizzle-orm";

import { getDb } from "./db";
import { globalJobCounters, rateLimitCounters } from "./db/schema";
import { HttpError } from "./httpError";

/**
 * Rate limiting & the global daily job cap.
 *
 * Counters are incremented with a single
 * `INSERT ... ON CONFLICT ... DO UPDATE SET count = count + 1 RETURNING count`,
 * so the check-and-increment is race-free without a read-then-write step. The
 * `set` clause must keep referencing the column, never a JavaScript value —
 * AGENTS.md has the race that reopens, and how to check the SQL Postgres
 * actually received.
 *
 * Checks are per-endpoint rather than blanket middleware: cheap reads
 * shouldn't be throttled, and the costly endpoints stay easy to audit.
 */

export async function checkAndIncrementIp(ip: string, limitPerHour: number): Promise<void> {
  await checkAndIncrement(`ip:${ip}`, truncateToHour(new Date()), limitPerHour);
}

export async function checkAndIncrementUser(userId: string, limitPerDay: number): Promise<void> {
  await checkAndIncrement(`user:${userId}`, truncateToDay(new Date()), limitPerDay);
}

/**
 * The central backstop on total GPU spend — independent of
 * user/IP identity, checked only when a job is actually about to launch.
 */
export async function checkAndIncrementGlobalDaily(maxJobsPerDay: number): Promise<void> {
  const day = truncateToDay(new Date());

  const [counter] = await getDb()
    .insert(globalJobCounters)
    .values({ day, jobsStarted: 1 })
    .onConflictDoUpdate({
      target: globalJobCounters.day,
      set: { jobsStarted: sql`${globalJobCounters.jobsStarted} + 1` },
    })
    .returning({ jobsStarted: globalJobCounters.jobsStarted });

  if (counter.jobsStarted > maxJobsPerDay) {
    throw new HttpError(503, "Daily processing limit reached — try again tomorrow.");
  }
}

async function checkAndIncrement(scope: string, windowStart: Date, limit: number): Promise<void> {
  const [counter] = await getDb()
    .insert(rateLimitCounters)
    .values({ scope, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimitCounters.scope, rateLimitCounters.windowStart],
      set: { count: sql`${rateLimitCounters.count} + 1` },
    })
    .returning({ count: rateLimitCounters.count });

  if (counter.count > limit) {
    throw new HttpError(429, "Rate limit exceeded — please slow down.");
  }
}

function truncateToHour(dt: Date): Date {
  const out = new Date(dt);
  out.setUTCMinutes(0, 0, 0);
  return out;
}

function truncateToDay(dt: Date): Date {
  const out = new Date(dt);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}
