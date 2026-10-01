import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "clerk-user-1" })),
  clerkClient: async () => ({ users: { getUser: async () => ({}) } }),
}));

import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { photos, splats, users } from "@/lib/server/db/schema";
import type { PhotoListItem } from "@/lib/types";
import { GET } from "./route";

function ctx(splatId: string) {
  return { params: Promise.resolve({ splatId }) } as never;
}

describe("GET /api/v1/splats/[splatId]/photos", () => {
  beforeEach(async () => {
    await getDb().delete(photos);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("returns only uploaded photos, ordered oldest first", async () => {
    const user = await getOrCreateUser("clerk-user-1");
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "obj" }).returning();
    await getDb()
      .insert(photos)
      .values([
        {
          splatId: splat.id,
          s3Key: `splats/${splat.id}/photos/second.jpg`,
          originalFilename: "second.jpg",
          contentType: "image/jpeg",
          width: 3024,
          height: 4032,
          uploadStatus: "uploaded",
          createdAt: new Date("2026-01-01T00:01:00Z"),
        },
        {
          splatId: splat.id,
          s3Key: `splats/${splat.id}/photos/first.jpg`,
          thumbnailS3Key: `splats/${splat.id}/photo-thumbnails/first.jpg`,
          originalFilename: "first.jpg",
          contentType: "image/jpeg",
          width: 4032,
          height: 3024,
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
          createdAt: new Date("2026-01-01T00:02:00Z"),
        },
      ]);

    const res = await GET({} as never, ctx(splat.id));
    const body: PhotoListItem[] = await res.json();

    expect(body.map(p => p.originalFilename)).toEqual(["first.jpg", "second.jpg"]);
    expect(body[0].url).toContain("first.jpg");

    // A photo with a thumbnail links to it, and one without falls back to the original.
    expect(body[0].thumbnailUrl).toContain("photo-thumbnails/first.jpg");
    expect(body[1].thumbnailUrl).toContain("photos/second.jpg");
    expect(body.map(p => [p.width, p.height])).toEqual([
      [4032, 3024],
      [3024, 4032],
    ]);
  });

  it("orders photos oldest taken first, with photos that have no capture time last", async () => {
    const user = await getOrCreateUser("clerk-user-1");
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "obj" }).returning();
    function photo(name: string, takenAt: Date | null, createdAt: Date) {
      return {
        splatId: splat.id,
        s3Key: `splats/${splat.id}/photos/${name}`,
        originalFilename: name,
        contentType: "image/jpeg",
        width: 4032,
        height: 3024,
        takenAt,
        uploadStatus: "uploaded" as const,
        createdAt,
      };
    }

    // Uploaded in one order, taken in another.
    await getDb()
      .insert(photos)
      .values([
        photo("undated.jpg", null, new Date("2026-01-01T00:00:00Z")),
        photo("later.jpg", new Date("2025-06-01T12:00:05Z"), new Date("2026-01-01T00:00:01Z")),
        photo("earlier.jpg", new Date("2025-06-01T12:00:00Z"), new Date("2026-01-01T00:00:02Z")),
      ]);

    const res = await GET({} as never, ctx(splat.id));
    const body: PhotoListItem[] = await res.json();
    expect(body.map(p => p.originalFilename)).toEqual(["earlier.jpg", "later.jpg", "undated.jpg"]);
  });

  it("404s for a splat that isn't the caller's", async () => {
    const otherOwner = await getOrCreateUser("clerk-user-2");
    const [splat] = await getDb().insert(splats).values({ userId: otherOwner.id, name: "not mine" }).returning();

    const res = await GET({} as never, ctx(splat.id));
    expect(res.status).toBe(404);
  });

  it("404s for a malformed id without reaching the database", async () => {
    const res = await GET({} as never, ctx("not-a-uuid"));
    expect(res.status).toBe(404);
  });
});
