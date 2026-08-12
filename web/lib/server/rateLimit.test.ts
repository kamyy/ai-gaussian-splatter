import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb } from "./db";
import { HttpError } from "./httpError";
import { checkAndIncrementGlobalDaily, checkAndIncrementIp, checkAndIncrementUser } from "./rateLimit";

/**
 * Requires a real Postgres (TEST_DATABASE_URL): these exercise the
 * `INSERT ... ON CONFLICT` upsert, which is the whole point of the
 * implementation and can't be faithfully faked. CI wires it to a service
 * container.
 */
const hasPostgres = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasPostgres)("rate limiting", () => {
  beforeEach(async () => {
    // Truncate rather than drop/recreate per test: the schema is applied once
    // by the migrate step, and this is far faster than a full DDL cycle.
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

  it("applies the global cap regardless of caller", async () => {
    // The whole point of the global cap: it isn't keyed by user/IP,
    // so no amount of multi-accounting raises the effective ceiling.
    await checkAndIncrementIp("1.1.1.1", 100);
    await checkAndIncrementGlobalDaily(1);

    await checkAndIncrementIp("2.2.2.2", 100);
    await expect(checkAndIncrementGlobalDaily(1)).rejects.toMatchObject({ status: 503 });
  });

  it("raises HttpError, so handlers convert it to a response", async () => {
    await expect(checkAndIncrementGlobalDaily(0)).rejects.toBeInstanceOf(HttpError);
  });

  it("increments atomically under concurrency", async () => {
    // Guards the property, not the implementation: whatever issues the
    // increment must do it in one statement, so concurrent callers can't both
    // read the same count and slip past the limit.
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => checkAndIncrementIp("198.51.100.1", 10)));
    const allowed = results.filter(r => r.status === "fulfilled").length;
    const rejected = results.filter(r => r.status === "rejected").length;

    expect(allowed).toBe(10);
    expect(rejected).toBe(10);
  });
});
