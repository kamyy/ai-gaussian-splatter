import { HttpError } from "./httpError";
import { getPrisma } from "./prisma";

/**
 * Rate limiting & the global daily job cap (plan §5).
 *
 * Counters are incremented with `upsert()`, which Prisma compiles to a single
 * `INSERT ... ON CONFLICT ... DO UPDATE SET count = count + 1` — so the
 * check-and-increment is race-free without a read-then-write step.
 *
 * The `update` clause must stay non-empty for that to hold. Prisma only emits
 * the native statement when there is something to update; an empty `update: {}`
 * silently falls back to SELECT-then-INSERT, which does have the race.
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

  const counter = await getPrisma().globalJobCounter.upsert({
    where: { day },
    create: { day, jobsStarted: 1 },
    update: { jobsStarted: { increment: 1 } },
  });

  if (counter.jobsStarted > maxJobsPerDay) {
    throw new HttpError(503, "Daily processing limit reached — try again tomorrow.");
  }
}

async function checkAndIncrement(scope: string, windowStart: Date, limit: number): Promise<void> {
  const counter = await getPrisma().rateLimitCounter.upsert({
    where: { scope_windowStart: { scope, windowStart } },
    create: { scope, windowStart, count: 1 },
    update: { count: { increment: 1 } },
  });

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
