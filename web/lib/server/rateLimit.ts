import { sql } from "drizzle-orm";

import { getDb } from "./db";
import { globalJobCounters, rateLimitCounters } from "./db/schema";
import { HttpError } from "./httpError";

/**
 * Rate limiting & the global daily job cap (plan §5).
 *
 * Counters are incremented with a single
 * `INSERT ... ON CONFLICT ... DO UPDATE SET count = count + 1 RETURNING count`,
 * so the check-and-increment is race-free without a read-then-write step. The
 * statement is written out here rather than inferred from an ORM helper, which
 * is the point: the previous Prisma `upsert()` only compiled to this when its
 * `update` clause happened to be non-empty, and silently degraded to
 * SELECT-then-INSERT otherwise.
 *
 * The `set` clause must reference the column (`rate_limit_counters.count + 1`),
 * not a JavaScript value — a plain `{ count: n + 1 }` would bake in a number
 * read before the statement ran, reopening exactly the race this avoids.
 *
 * Checks are per-endpoint rather than blanket middleware (plan §5): cheap reads
 * shouldn't be throttled, and the costly endpoints stay easy to audit.
 */

export async function checkAndIncrementIp(ip: string, limitPerHour: number): Promise<void> {
  await checkAndIncrement(`ip:${ip}`, truncateToHour(new Date()), limitPerHour);
}

export async function checkAndIncrementUser(userId: string, limitPerDay: number): Promise<void> {
  await checkAndIncrement(`user:${userId}`, truncateToDay(new Date()), limitPerDay);
}

/**
 * The central backstop on total GPU spend (plan §5) — independent of
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
