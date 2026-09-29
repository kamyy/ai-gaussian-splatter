import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId: "clerk-user-1" })) }));

import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { jobs, photos, splats, users } from "@/lib/server/db/schema";
import { GET, POST } from "./route";

// Requires a real Postgres (TEST_DATABASE_URL). Covers what GET /api/v1/splats adds on top of the plain splat list:
// photo counts, job statuses, and thumbnails. The route runs two extra queries (uploaded photos and latest jobs)
// batched with inArray() over every splat id, then reduces the rows in JS to one per splat. These tests check that
// reduction, not the number of queries.
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
      thumbnailWidth: null,
      thumbnailHeight: null,
    });
  });

  it("counts uploaded photos and takes the thumbnail from the first one taken, ignoring pending ones", async () => {
    const user = await getOrCreateUser("clerk-user-1");
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "With photos" }).returning();
    await getDb()
      .insert(photos)
      .values([
        {
          splatId: splat.id,
          s3Key: `splats/${splat.id}/photos/first.jpg`,
          thumbnailS3Key: `splats/${splat.id}/photo-thumbnails/first.jpg`,
          originalFilename: "first.jpg",
          contentType: "image/jpeg",
          width: 3024,
          height: 4032,
          // Taken first, though uploaded second.
          takenAt: new Date("2025-06-01T12:00:00Z"),
          uploadStatus: "uploaded",
          createdAt: new Date("2026-01-01T00:01:00Z"),
        },
        {
          splatId: splat.id,
          s3Key: `splats/${splat.id}/photos/second.jpg`,
          originalFilename: "second.jpg",
          contentType: "image/jpeg",
          width: 4032,
          height: 3024,
          takenAt: new Date("2025-06-01T12:00:05Z"),
          uploadStatus: "uploaded",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
        {
          splatId: splat.id,
          s3Key: `splats/${splat.id}/photos/pending.jpg`,
          originalFilename: "pending.jpg",
          contentType: "image/jpeg",
          width: 4032,
          height: 3024,
          uploadStatus: "pending",
          createdAt: new Date("2025-12-31T23:59:00Z"),
        },
      ]);

    const res = await GET();
    const [item] = await res.json();

    expect(item.photoCount).toBe(2);
    expect(item.thumbnailPhotoUrl).toContain("photo-thumbnails/first.jpg");
    expect([item.thumbnailWidth, item.thumbnailHeight]).toEqual([3024, 4032]);
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
    // A later retry. The response should reflect this job, not the earlier failed one.
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

  it("keeps each splat's photos and job apart, newest splat first", async () => {
    const user = await getOrCreateUser("clerk-user-1");
    const [older] = await getDb()
      .insert(splats)
      .values({ userId: user.id, name: "Older", createdAt: new Date("2026-01-01T00:00:00Z") })
      .returning();
    const [newer] = await getDb()
      .insert(splats)
      .values({ userId: user.id, name: "Newer", createdAt: new Date("2026-01-02T00:00:00Z") })
      .returning();
    function uploaded(splatId: string, name: string) {
      return {
        splatId,
        s3Key: `splats/${splatId}/photos/${name}`,
        originalFilename: name,
        contentType: "image/jpeg",
        width: 4032,
        height: 3024,
        uploadStatus: "uploaded" as const,
      };
    }

    await getDb()
      .insert(photos)
      .values([uploaded(older.id, "a.jpg"), uploaded(older.id, "b.jpg"), uploaded(newer.id, "c.jpg")]);
    await getDb()
      .insert(jobs)
      .values([
        { splatId: older.id, status: "complete", callbackToken: "token-1" },
        { splatId: newer.id, status: "failed", callbackToken: "token-2" },
      ]);

    const res = await GET();
    const body = await res.json();

    expect(body.map((item: { name: string }) => item.name)).toEqual(["Newer", "Older"]);
    expect(body[0]).toMatchObject({ photoCount: 1, latestJobStatus: "failed" });
    expect(body[0].thumbnailPhotoUrl).toContain(`splats/${newer.id}/photos/c.jpg`);
    expect(body[1]).toMatchObject({ photoCount: 2, latestJobStatus: "complete" });
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

// Requires a real Postgres (TEST_DATABASE_URL).
describe("POST /api/v1/splats", () => {
  beforeEach(async () => {
    await getDb().delete(jobs);
    await getDb().delete(photos);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  afterAll(async () => {
    await closeDb();
  });

  function createRequest(body?: unknown) {
    return new Request("http://localhost/api/v1/splats", {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it("creates a draft splat owned by the caller", async () => {
    const res = await POST(createRequest({ name: "Mug" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ name: "Mug", status: "draft" });

    const user = await getOrCreateUser("clerk-user-1");
    const [row] = await getDb().select().from(splats);
    expect(row).toMatchObject({ id: body.id, userId: user.id });
  });

  it.each([
    ["an empty name", { name: "" }],
    ["a missing name", {}],
    ["no body", undefined],
  ])("422s on %s without creating anything", async (_label, body) => {
    const res = await POST(createRequest(body));
    expect(res.status).toBe(422);
    expect(await getDb().select().from(splats)).toEqual([]);
  });
});
