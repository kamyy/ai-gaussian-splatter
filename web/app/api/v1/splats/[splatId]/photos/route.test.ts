import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId: "clerk-user-1" })) }));

import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { photos, splats, users } from "@/lib/server/db/schema";
import { GET } from "./route";

const hasPostgres = Boolean(process.env.TEST_DATABASE_URL);

function ctx(splatId: string) {
  return { params: Promise.resolve({ splatId }) } as never;
}

describe.skipIf(!hasPostgres)("GET /api/v1/splats/[splatId]/photos", () => {
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
          uploadStatus: "uploaded",
          createdAt: new Date("2026-01-01T00:01:00Z"),
        },
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
          s3Key: `splats/${splat.id}/photos/pending.jpg`,
          originalFilename: "pending.jpg",
          contentType: "image/jpeg",
          uploadStatus: "pending",
          createdAt: new Date("2026-01-01T00:02:00Z"),
        },
      ]);

    const res = await GET({} as never, ctx(splat.id));
    const body: { originalFilename: string; url: string }[] = await res.json();

    expect(body.map(p => p.originalFilename)).toEqual(["first.jpg", "second.jpg"]);
    expect(body[0].url).toContain("first.jpg");
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
