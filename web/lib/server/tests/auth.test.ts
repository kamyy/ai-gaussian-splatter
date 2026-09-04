import { count } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getClientIp, getJobForCallbackToken, getOrCreateUser } from "../auth";
import { closeDb, getDb } from "../db";
import { jobs, splats, users } from "../db/schema";

/**
 * @clerk/nextjs verifies JWTs, and testing Clerk's own code isn't this suite's job. What's worth testing is the
 * app-specific logic: the lazy shadow-row upsert and the worker's per-job token check.
 */
vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));

function fakeRequest(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

describe("getClientIp", () => {
  it("uses the last hop of X-Forwarded-For", () => {
    // The ALB appends the address it actually saw, so that is the trustworthy entry — see the note in
    // web/lib/server/auth.ts about a second proxy invalidating this.
    const req = fakeRequest({ "X-Forwarded-For": "203.0.113.5, 70.41.3.18, 150.172.238.178" });
    expect(getClientIp(req)).toBe("150.172.238.178");
  });

  it("cannot be spoofed into a fresh rate-limit bucket", () => {
    // A caller varying the header still keys on the ALB-appended address.
    const spoofA = fakeRequest({ "X-Forwarded-For": "1.1.1.1, 198.51.100.7" });
    const spoofB = fakeRequest({ "X-Forwarded-For": "2.2.2.2, 198.51.100.7" });
    expect(getClientIp(spoofA)).toBe(getClientIp(spoofB));
  });

  it("trims whitespace and ignores empty entries", () => {
    expect(getClientIp(fakeRequest({ "X-Forwarded-For": "  70.41.3.18  ,  203.0.113.5  " }))).toBe("203.0.113.5");
    expect(getClientIp(fakeRequest({ "X-Forwarded-For": "203.0.113.5, " }))).toBe("203.0.113.5");
  });

  it("falls back to 'unknown' when the header is absent", () => {
    // NextRequest exposes no socket address to fall back to.
    expect(getClientIp(fakeRequest({}))).toBe("unknown");
  });
});

const hasPostgres = Boolean(process.env.TEST_DATABASE_URL);

async function userCount(): Promise<number> {
  const [row] = await getDb().select({ n: count() }).from(users);
  return row.n;
}

describe.skipIf(!hasPostgres)("database-backed auth helpers", () => {
  beforeEach(async () => {
    // Ordered to respect the foreign keys: jobs and photos hang off splats, splats off users.
    await getDb().delete(jobs);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  afterAll(async () => {
    await closeDb();
  });

  describe("getOrCreateUser", () => {
    it("creates the local shadow row on first request", async () => {
      const user = await getOrCreateUser("user_clerk_1");
      expect(user.clerkUserId).toBe("user_clerk_1");
      expect(await userCount()).toBe(1);
    });

    it("returns the same row on subsequent requests", async () => {
      const first = await getOrCreateUser("user_clerk_1");
      const second = await getOrCreateUser("user_clerk_1");
      expect(second.id).toBe(first.id);
      expect(await userCount()).toBe(1);
    });

    it("does not duplicate when concurrent first-requests race", async () => {
      // Not `users` — that name is the table import this file queries through.
      const racers = await Promise.all(Array.from({ length: 10 }, () => getOrCreateUser("user_clerk_race")));
      const ids = new Set(racers.map(u => u.id));
      expect(ids.size).toBe(1);
      expect(await userCount()).toBe(1);
    });
  });

  describe("getJobForCallbackToken", () => {
    async function seedJob(callbackToken: string) {
      const [user] = await getDb()
        .insert(users)
        .values({ clerkUserId: `u-${callbackToken}` })
        .returning();
      const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "s" }).returning();
      const [job] = await getDb().insert(jobs).values({ splatId: splat.id, callbackToken }).returning();
      return job;
    }

    it("returns the job when the bearer token matches", async () => {
      const job = await seedJob("tok-good");
      const found = await getJobForCallbackToken(job.id, fakeRequest({ Authorization: "Bearer tok-good" }));
      expect(found.id).toBe(job.id);
    });

    it("rejects a mismatched token with 401", async () => {
      const job = await seedJob("tok-good");
      await expect(
        getJobForCallbackToken(job.id, fakeRequest({ Authorization: "Bearer tok-wrong" })),
      ).rejects.toMatchObject({ status: 401 });
    });

    it("rejects a missing Authorization header with 401", async () => {
      const job = await seedJob("tok-good");
      await expect(getJobForCallbackToken(job.id, fakeRequest({}))).rejects.toMatchObject({ status: 401 });
    });

    it("rejects a valid token for a different job", async () => {
      // The token is scoped to one job, so a compromised instance can't mutate anyone else's.
      await seedJob("tok-a");
      const other = await seedJob("tok-b");
      await expect(
        getJobForCallbackToken(other.id, fakeRequest({ Authorization: "Bearer tok-a" })),
      ).rejects.toMatchObject({ status: 401 });
    });

    it("rejects an unknown job id with 401", async () => {
      await expect(
        getJobForCallbackToken(
          "11111111-1111-4111-8111-111111111111",
          fakeRequest({ Authorization: "Bearer tok-good" }),
        ),
      ).rejects.toMatchObject({ status: 401 });
    });
  });
});
