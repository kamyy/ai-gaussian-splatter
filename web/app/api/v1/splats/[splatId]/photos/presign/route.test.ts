import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId: "clerk-user-1" })) }));

import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { photos, rateLimitCounters, splats, users } from "@/lib/server/db/schema";
import { MAX_PHOTOS_PER_SPLAT } from "@/lib/types";
import { POST } from "./route";

function ctx(splatId: string) {
  return { params: Promise.resolve({ splatId }) } as never;
}

function presignRequest(body: unknown) {
  return new NextRequest("http://localhost/api/v1/splats/presign", { method: "POST", body: JSON.stringify(body) });
}

// Requires a real Postgres (TEST_DATABASE_URL). Signing an S3 URL is local, so nothing reaches AWS.
describe("POST /api/v1/splats/[splatId]/photos/presign", () => {
  beforeEach(async () => {
    await getDb().delete(photos);
    await getDb().delete(splats);
    await getDb().delete(users);
    await getDb().delete(rateLimitCounters);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function seedSplat() {
    const user = await getOrCreateUser("clerk-user-1");
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "obj" }).returning();
    return splat;
  }

  it("stores each photo's dimensions and capture time", async () => {
    const splat = await seedSplat();

    const res = await POST(
      presignRequest([
        {
          filename: "a.jpg",
          contentType: "image/jpeg",
          width: 3024,
          height: 4032,
          takenAt: "2026-01-01T10:00:00.000Z",
        },
        {
          filename: "b.jpg",
          contentType: "image/jpeg",
          width: 4032,
          height: 3024,
          takenAt: "2026-01-01T10:00:05.000Z",
        },
      ]),
      ctx(splat.id),
    );
    expect(res.status).toBe(200);

    const rows = await getDb()
      .select({
        originalFilename: photos.originalFilename,
        width: photos.width,
        height: photos.height,
        takenAt: photos.takenAt,
      })
      .from(photos)
      .orderBy(photos.originalFilename);
    expect(rows).toEqual([
      { originalFilename: "a.jpg", width: 3024, height: 4032, takenAt: new Date("2026-01-01T10:00:00.000Z") },
      { originalFilename: "b.jpg", width: 4032, height: 3024, takenAt: new Date("2026-01-01T10:00:05.000Z") },
    ]);
  });

  function photoItem(filename: string) {
    return { filename, contentType: "image/jpeg", width: 3024, height: 4032, takenAt: "2026-01-01T10:00:00.000Z" };
  }

  async function seedPhotos(splatId: string, n: number, uploadStatus: "pending" | "uploaded") {
    await getDb()
      .insert(photos)
      .values(
        Array.from({ length: n }, (_, i) => ({
          splatId,
          s3Key: `splats/${splatId}/photos/${uploadStatus}-${i}.jpg`,
          originalFilename: `${uploadStatus}-${i}.jpg`,
          contentType: "image/jpeg",
          width: 3024,
          height: 4032,
          uploadStatus,
        })),
      );
  }

  it("rejects a batch that would take the splat past MAX_PHOTOS_PER_SPLAT, without spending the rate limit", async () => {
    const splat = await seedSplat();
    await seedPhotos(splat.id, MAX_PHOTOS_PER_SPLAT - 1, "uploaded");

    const res = await POST(presignRequest([photoItem("a.jpg"), photoItem("b.jpg")]), ctx(splat.id));
    expect(res.status).toBe(400);
    expect(await getDb().select().from(rateLimitCounters)).toEqual([]);

    const last = await POST(presignRequest([photoItem("a.jpg")]), ctx(splat.id));
    expect(last.status).toBe(200);
  });

  it("doesn't count a failed batch's photos that were never uploaded", async () => {
    const splat = await seedSplat();
    await seedPhotos(splat.id, MAX_PHOTOS_PER_SPLAT, "pending");

    const res = await POST(presignRequest([photoItem("a.jpg")]), ctx(splat.id));
    expect(res.status).toBe(200);
  });

  it("rejects a photo sent without its capture time", async () => {
    const splat = await seedSplat();

    const res = await POST(
      presignRequest([{ filename: "a.jpg", contentType: "image/jpeg", width: 3024, height: 4032 }]),
      ctx(splat.id),
    );
    expect(res.status).toBe(422);
  });

  it("issues a thumbnail upload URL beside each photo's, outside the folder the worker downloads", async () => {
    const splat = await seedSplat();

    const res = await POST(
      presignRequest([
        {
          filename: "a.jpg",
          contentType: "image/jpeg",
          width: 3024,
          height: 4032,
          takenAt: "2026-01-01T10:00:00.000Z",
        },
      ]),
      ctx(splat.id),
    );
    const [item] = await res.json();

    const [row] = await getDb().select({ thumbnailS3Key: photos.thumbnailS3Key }).from(photos);
    expect(row.thumbnailS3Key).toBe(`splats/${splat.id}/photo-thumbnails/${item.photoId}.jpg`);
    expect(item.thumbnailPutUrl).toContain(`splats/${splat.id}/photo-thumbnails/${item.photoId}.jpg`);
  });

  it("rejects a dimension that isn't a positive whole number", async () => {
    const splat = await seedSplat();

    const res = await POST(
      presignRequest([
        { filename: "a.jpg", contentType: "image/jpeg", width: 0, height: 4032, takenAt: "2026-01-01T10:00:00.000Z" },
      ]),
      ctx(splat.id),
    );
    expect(res.status).toBe(422);
  });

  it("rejects a photo sent without its height", async () => {
    const splat = await seedSplat();

    const res = await POST(
      presignRequest([
        { filename: "a.jpg", contentType: "image/jpeg", width: 3024, takenAt: "2026-01-01T10:00:00.000Z" },
      ]),
      ctx(splat.id),
    );
    expect(res.status).toBe(422);
  });
});
