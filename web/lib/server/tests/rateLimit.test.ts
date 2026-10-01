import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb } from "../db";
import { HttpError } from "../httpError";
import {
  checkAndIncrementGlobalDaily,
  checkAndIncrementIp,
  checkAndIncrementUser,
  formatWaitUntil,
  pruneRateLimitCounters,
} from "../rateLimit";

// Requires a real Postgres (TEST_DATABASE_URL). These tests exercise the `INSERT ... ON CONFLICT` upsert, which is the
// whole point of the implementation and can't be faked faithfully. CI starts that Postgres as a podman container
// (.github/workflows/ci.yml).
describe("rate limiting", () => {
  beforeEach(async () => {
    // Truncate rather than drop/recreate per test: the schema is applied once by the migrate step, and this is far
    // faster than a full DDL cycle.
    await getDb().execute(sql`TRUNCATE rate_limit_counters, global_job_counters RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("allows requests up to the per-IP limit", async () => {
    for (let i = 0; i < 3; i++) {
      await checkAndIncrementIp("203.0.113.5", 3);
    }
  });

  it("throws 429 once the per-IP limit is exceeded", async () => {
    for (let i = 0; i < 3; i++) {
      await checkAndIncrementIp("203.0.113.5", 3);
    }

    await expect(checkAndIncrementIp("203.0.113.5", 3)).rejects.toMatchObject({ status: 429 });
  });

  it("counts each IP independently", async () => {
    for (let i = 0; i < 3; i++) {
      await checkAndIncrementIp("203.0.113.5", 3);
    }

    // A different IP has its own counter and is unaffected.
    await expect(checkAndIncrementIp("203.0.113.9", 3)).resolves.toBeUndefined();
  });

  // The counters hold IP addresses, and the privacy policy promises they are deleted within two days.
  it("prunes counters whose window has finished, and keeps the current ones", async () => {
    await getDb().execute(
      sql`INSERT INTO rate_limit_counters (scope, window_start, count) VALUES
        ('ip:203.0.113.1', now() - interval '25 hours', 1),
        ('user:user-a', now() - interval '23 hours', 1)`,
    );
    await checkAndIncrementIp("203.0.113.5", 3);

    await pruneRateLimitCounters();

    const rows = await getDb().execute<{ scope: string }>(sql`SELECT scope FROM rate_limit_counters ORDER BY scope`);
    expect(rows.rows.map(row => row.scope)).toEqual(["ip:203.0.113.5", "user:user-a"]);
  });

  it("counts each user independently", async () => {
    for (let i = 0; i < 2; i++) {
      await checkAndIncrementUser("user-a", 2);
    }

    await expect(checkAndIncrementUser("user-a", 2)).rejects.toMatchObject({ status: 429 });
    await expect(checkAndIncrementUser("user-b", 2)).resolves.toBeUndefined();
  });

  it("throws 503 once the global daily cap is exceeded", async () => {
    for (let i = 0; i < 2; i++) {
      await checkAndIncrementGlobalDaily(2);
    }

    await expect(checkAndIncrementGlobalDaily(2)).rejects.toMatchObject({ status: 503 });
  });

  it("names the limit that was hit in each message", async () => {
    await checkAndIncrementIp("203.0.113.5", 1);
    await expect(checkAndIncrementIp("203.0.113.5", 1)).rejects.toThrow(/uploads from your network.*1 an hour/);

    await checkAndIncrementUser("user-a", 1);
    await expect(checkAndIncrementUser("user-a", 1)).rejects.toThrow(/all 1 of today's uploads for your account/);

    await expect(checkAndIncrementGlobalDaily(0)).rejects.toThrow(/all 0 of today's GPU runs, which every user shares/);
  });

  it("raises HttpError, so handlers convert it to a response", async () => {
    await expect(checkAndIncrementGlobalDaily(0)).rejects.toBeInstanceOf(HttpError);
  });

  it.each([
    [30_000, "1 minute"],
    [12 * 60_000, "12 minutes"],
    [59 * 60_000 + 1, "about 1 hour"],
    [5 * 60 * 60_000 + 10 * 60_000, "about 5 hours"],
  ])("formats a wait of %i ms as %s", (ms, expected) => {
    const now = new Date("2026-09-30T12:00:00Z");

    expect(formatWaitUntil(new Date(now.getTime() + ms), now)).toBe(expected);
  });

  it("increments atomically under concurrency", async () => {
    // Guards the property, not the implementation: whatever issues the increment must do it in one statement, so
    // concurrent callers can't both read the same count and slip past the limit.
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => checkAndIncrementIp("198.51.100.1", 10)));
    const allowed = results.filter(r => r.status === "fulfilled").length;
    const rejected = results.filter(r => r.status === "rejected").length;

    expect(allowed).toBe(10);
    expect(rejected).toBe(10);
  });
});
