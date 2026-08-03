import { Prisma } from "@prisma/client";

import { HttpError } from "./httpError";
import { getPrisma } from "./prisma";

/**
 * Rate limiting & the global daily job cap (plan §5).
 *
 * These MUST stay raw SQL. Prisma's `upsert()` is not an atomic upsert — it
 * issues a SELECT then an INSERT/UPDATE, which reopens the check-and-increment
 * race that `ON CONFLICT ... RETURNING` closes. Concurrent callers could then
 * exceed the limit, and the global counter is what bounds worst-case GPU spend.
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

  const rows = await getPrisma().$queryRaw<{ jobs_started: number }[]>(Prisma.sql`
    INSERT INTO global_job_counters (day, jobs_started)
    VALUES (${day}, 1)
    ON CONFLICT (day)
    DO UPDATE SET jobs_started = global_job_counters.jobs_started + 1
    RETURNING jobs_started
  `);

  const newCount = rows[0]?.jobs_started;
  if (newCount === undefined) {
    throw new Error("global daily counter upsert returned no row");
  }
  if (newCount > maxJobsPerDay) {
    throw new HttpError(503, "Daily processing limit reached — try again tomorrow.");
  }
}

async function checkAndIncrement(scope: string, windowStart: Date, limit: number): Promise<void> {
  const rows = await getPrisma().$queryRaw<{ count: number }[]>(Prisma.sql`
    INSERT INTO rate_limit_counters (scope, window_start, count)
    VALUES (${scope}, ${windowStart}, 1)
    ON CONFLICT (scope, window_start)
    DO UPDATE SET count = rate_limit_counters.count + 1
    RETURNING count
  `);

  const newCount = rows[0]?.count;
  if (newCount === undefined) {
    throw new Error("rate limit counter upsert returned no row");
  }
  if (newCount > limit) {
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
