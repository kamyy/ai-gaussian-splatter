/**
 * Rate limits per IP address and per user, and the site-wide daily cap on worker jobs.
 *
 * Each check counts one request in a Postgres counter and throws a 429 once the limit is passed. The counter update is
 * a single INSERT ... ON CONFLICT ... DO UPDATE SET count = count + 1 RETURNING count, so the check-and-increment is
 * race-free without a read-then-write step. The `set` clause must keep referencing the column, never a JavaScript
 * value. AGENTS.md has the race that reopens, and how to check the SQL Postgres actually received.
 *
 * Checks are per endpoint rather than blanket middleware, since cheap reads shouldn't be throttled. The costly
 * endpoints stay easy to audit this way too.
 *
 * Finished counters are deleted every hour by a timer that web/instrumentation.ts starts with the server. They hold IP
 * addresses, and web/app/(public)/privacy/page.tsx promises those are gone within two days. A check only ever reads its
 * current window, so deleting finished ones changes no limit.
 *
 * Each rejection names the limit that was hit and how long until it resets, since the message is shown to the user
 * as it is. The per-IP and per-user messages speak of uploads, because photo presigning is the one endpoint they guard.
 */

import { lt, sql } from "drizzle-orm";

import { getDb } from "./db";
import { globalJobCounters, rateLimitCounters } from "./db/schema";
import { HttpError } from "./httpError";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The longest window is a day, so any counter that started over a day ago has finished.
const COUNTER_RETENTION_MS = DAY_MS;
const PRUNE_INTERVAL_MS = HOUR_MS;
const FIRST_PRUNE_DELAY_MS = 60 * 1000;

export async function checkAndIncrementIp(ip: string, limitPerHour: number): Promise<void> {
  const hour = truncateToHour(new Date());
  const wait = formatWaitUntil(new Date(hour.getTime() + HOUR_MS));

  await checkAndIncrement(
    `ip:${ip}`,
    hour,
    limitPerHour,
    `Too many uploads from your network. It can make ${limitPerHour} an hour, so try again in ${wait}.`,
  );
}

/** The counter scope for one user's daily upload limit. Deleting an account deletes that user's counter by it. */
export function userRateLimitScope(userId: string): string {
  return `user:${userId}`;
}

export async function checkAndIncrementUser(userId: string, limitPerDay: number): Promise<void> {
  const day = truncateToDay(new Date());
  const wait = formatWaitUntil(new Date(day.getTime() + DAY_MS));

  await checkAndIncrement(
    userRateLimitScope(userId),
    day,
    limitPerDay,
    `You've used all ${limitPerDay} of today's uploads for your account. Try again in ${wait}, after midnight UTC.`,
  );
}

/**
 * The central backstop on total GPU spend. It ignores who the user is and which IP they come from, and it is checked
 * only when a worker job is actually about to launch.
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
    const wait = formatWaitUntil(new Date(day.getTime() + DAY_MS));
    throw new HttpError(
      503,
      `The site has used all ${maxJobsPerDay} of today's GPU runs, which every user shares. ` +
        `Try again in ${wait}, after midnight UTC.`,
    );
  }
}

async function checkAndIncrement(scope: string, windowStart: Date, limit: number, message: string): Promise<void> {
  const [counter] = await getDb()
    .insert(rateLimitCounters)
    .values({ scope, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimitCounters.scope, rateLimitCounters.windowStart],
      set: { count: sql`${rateLimitCounters.count} + 1` },
    })
    .returning({ count: rateLimitCounters.count });

  if (counter.count > limit) {
    throw new HttpError(429, message);
  }
}

/** Deletes every counter whose window has finished. Exported for its tests. */
export async function pruneRateLimitCounters(): Promise<void> {
  await getDb()
    .delete(rateLimitCounters)
    .where(lt(rateLimitCounters.windowStart, new Date(Date.now() - COUNTER_RETENTION_MS)));
}

/**
 * Prunes a minute after the server starts, then once an hour for as long as it runs. The first prune doesn't wait the
 * full hour, so tasks that restart more often than hourly still prune. The minute's delay keeps it out of `next build`,
 * whose workers also start this file and exit within seconds. unref() lets such a process exit instead of waiting on a
 * timer. A failed prune is logged, and the next one tries again.
 */
export function startRateLimitPruning() {
  const prune = () => {
    pruneRateLimitCounters().catch(err => console.error("Couldn't prune rate-limit counters", err));
  };

  setTimeout(prune, FIRST_PRUNE_DELAY_MS).unref();
  setInterval(prune, PRUNE_INTERVAL_MS).unref();
}

/** "12 minutes" under an hour, "about 5 hours" beyond it. Exported for its tests. */
export function formatWaitUntil(end: Date, now = new Date()): string {
  const minutes = Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 60_000));
  if (minutes < 60) {
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }

  const hours = Math.round(minutes / 60);

  return hours === 1 ? "about 1 hour" : `about ${hours} hours`;
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
