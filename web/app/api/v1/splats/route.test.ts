import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId: "clerk-user-1" })) }));

import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { jobs, photos, splats, users } from "@/lib/server/db/schema";
import { GET } from "./route";

/**
 * Requires a real Postgres (TEST_DATABASE_URL). Covers the photo-count/job-status/thumbnail aggregation
 * GET /api/v1/splats adds on top of the plain splat list: it runs two extra queries (uploaded photos, latest job) batched with inArray() over
 * every splat id, then reduces each in JS to one row per splat — these tests exercise that reduction's correctness
 * rather than the query count directly.
 */
describe("GET /api/v1/splats", () => {
  beforeEach(async () => {
    await getDb().delete(jobs);
    await getDb().delete(photos);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("reports no photos, no job, and no thumbnail for a splat with nothing uploaded", async () => {
    const user = await getOrCreateUser("clerk-user-1");
    await getDb().insert(splats).values({ userId: user.id, name: "Empty" });

    const res = await GET();
    const body = await res.json();

    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      name: "Empty",
      photoCount: 0,
      latestJobStatus: null,
      thumbnailPhotoUrl: null,
    });
  });

  it("counts uploaded photos and takes the thumbnail from the first one, ignoring pending ones", async () => {
    const user = await getOrCreateUser("clerk-user-1");
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "With photos" }).returning();
    await getDb()
      .insert(photos)
      .values([
        {
          splatId: splat.id,
          s3Key: `splats/${splat.id}/photos/first.jpg`,
          originalFilename: "first.jpg",
          contentType: "image/jpeg",
          uploadStatus: "uploaded",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
        {
          splatId: splat.id,
          s3Key: `splats/${splat.id}/photos/second.jpg`,
          originalFilename: "second.jpg",
          contentType: "image/jpeg",
          uploadStatus: "uploaded",
          createdAt: new Date("2026-01-01T00:01:00Z"),
        },
        {
          splatId: splat.id,
          s3Key: `splats/${splat.id}/photos/pending.jpg`,
          originalFilename: "pending.jpg",
          contentType: "image/jpeg",
          uploadStatus: "pending",
          createdAt: new Date("2025-12-31T23:59:00Z"),
        },
      ]);

    const res = await GET();
    const [item] = await res.json();

    expect(item.photoCount).toBe(2);
    expect(item.thumbnailPhotoUrl).toContain("first.jpg");
  });

  it("reports the latest job's status only", async () => {
    const user = await getOrCreateUser("clerk-user-1");
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "Processed" }).returning();
    await getDb()
      .insert(jobs)
      .values({
        splatId: splat.id,
        status: "failed",
        callbackToken: "token-1",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      });
    // A later retry — the response should reflect this one, not the earlier failed job.
    await getDb()
      .insert(jobs)
      .values({
        splatId: splat.id,
        status: "queued",
        callbackToken: "token-2",
        createdAt: new Date("2026-01-01T00:05:00Z"),
      });

    const res = await GET();
    const [item] = await res.json();

    expect(item.latestJobStatus).toBe("queued");
  });

  it("scopes results to the calling user", async () => {
    const user = await getOrCreateUser("clerk-user-1");
    const otherUser = await getOrCreateUser("clerk-user-2");
    await getDb().insert(splats).values({ userId: user.id, name: "Mine" });
    await getDb().insert(splats).values({ userId: otherUser.id, name: "Not mine" });

    const res = await GET();
    const body = await res.json();

    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("Mine");
  });
});
