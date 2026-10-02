import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "clerk-user-1" })),
  clerkClient: async () => ({ users: { getUser: async () => ({}) } }),
}));

import { MAX_PHOTO_BYTES, MAX_PHOTOS_PER_SPLAT } from "@/lib/limits";
import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { photos, rateLimitCounters, splats, users } from "@/lib/server/db/schema";
import { MAX_THUMBNAIL_BYTES } from "@/lib/server/s3";
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

  it("takes the per-user upload limit from the runtime settings", async () => {
    const splat = await seedSplat();
    const photo = {
      filename: "a.jpg",
      contentType: "image/jpeg",
      size: 4_000_000,
      thumbnailSize: 100_000,
      width: 3024,
      height: 4032,
      takenAt: "2026-01-01T10:00:00.000Z",
    };
    process.env.UPLOADS_PER_USER_PER_DAY = "1";
    try {
      expect((await POST(presignRequest([photo]), ctx(splat.id))).status).toBe(200);

      const res = await POST(presignRequest([photo]), ctx(splat.id));

      expect(res.status).toBe(429);
      expect((await res.json()).detail).toMatch(/all 1 of today's uploads for your account/);
    } finally {
      delete process.env.UPLOADS_PER_USER_PER_DAY;
    }
  });

  it("stores each photo's size, dimensions and capture time", async () => {
    const splat = await seedSplat();

    const res = await POST(
      presignRequest([
        {
          filename: "a.jpg",
          contentType: "image/jpeg",
          size: 4_000_000,
          thumbnailSize: 100_000,
          width: 3024,
          height: 4032,
          takenAt: "2026-01-01T10:00:00.000Z",
        },
        {
          filename: "b.jpg",
          contentType: "image/jpeg",
          size: 3_000_000,
          thumbnailSize: 100_000,
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
        sizeBytes: photos.sizeBytes,
        width: photos.width,
        height: photos.height,
        takenAt: photos.takenAt,
      })
      .from(photos)
      .orderBy(photos.originalFilename);
    expect(rows).toEqual([
      {
        originalFilename: "a.jpg",
        sizeBytes: 4_000_000,
        width: 3024,
        height: 4032,
        takenAt: new Date("2026-01-01T10:00:00.000Z"),
      },
      {
        originalFilename: "b.jpg",
        sizeBytes: 3_000_000,
        width: 4032,
        height: 3024,
        takenAt: new Date("2026-01-01T10:00:05.000Z"),
      },
    ]);
  });

  function photoItem(filename: string, size = 4_000_000, thumbnailSize = 100_000) {
    return {
      filename,
      contentType: "image/jpeg",
      size,
      thumbnailSize,
      width: 3024,
      height: 4032,
      takenAt: "2026-01-01T10:00:00.000Z",
    };
  }

  it("rejects a photo over MAX_PHOTO_BYTES, without spending the rate limit", async () => {
    const splat = await seedSplat();

    const res = await POST(presignRequest([photoItem("a.jpg", MAX_PHOTO_BYTES + 1)]), ctx(splat.id));
    expect(res.status).toBe(422);
    expect(await getDb().select().from(rateLimitCounters)).toEqual([]);

    const atCap = await POST(presignRequest([photoItem("a.jpg", MAX_PHOTO_BYTES)]), ctx(splat.id));
    expect(atCap.status).toBe(200);
  });

  it.each([
    // S3 serves an object with the content type it was uploaded with, so an HTML upload would be a page on S3's domain.
    ["a page", "a.html", "text/html"],
    // worker/pipeline/sfm.py skips anything but JPEG and PNG, so this photo would never reach COLMAP.
    ["a photo COLMAP can't read", "a.heic", "image/heic"],
  ])("rejects %s, without spending the rate limit", async (_label, filename, contentType) => {
    const splat = await seedSplat();

    const res = await POST(presignRequest([{ ...photoItem(filename), contentType }]), ctx(splat.id));
    expect(res.status).toBe(422);
    expect(await getDb().select().from(rateLimitCounters)).toEqual([]);
  });

  it("names the S3 key after the declared type, not the uploaded filename", async () => {
    const splat = await seedSplat();

    const res = await POST(presignRequest([{ ...photoItem("a.html"), contentType: "image/png" }]), ctx(splat.id));
    const [item] = await res.json();

    expect(item.s3Key).toBe(`splats/${splat.id}/photos/${item.photoId}.png`);
  });

  it("rejects a thumbnail over MAX_THUMBNAIL_BYTES", async () => {
    const splat = await seedSplat();

    const res = await POST(presignRequest([photoItem("a.jpg", 4_000_000, MAX_THUMBNAIL_BYTES + 1)]), ctx(splat.id));
    expect(res.status).toBe(422);
  });

  it("signs each photo's and thumbnail's declared size into its upload URL", async () => {
    const splat = await seedSplat();

    const res = await POST(presignRequest([photoItem("a.jpg", 1234)]), ctx(splat.id));
    const [item] = await res.json();

    expect(new URL(item.presignedPutUrl).searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
    expect(new URL(item.thumbnailPutUrl).searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
  });

  async function seedPhotos(splatId: string, n: number, uploadStatus: "pending" | "uploaded") {
    await getDb()
      .insert(photos)
      .values(
        Array.from({ length: n }, (_, i) => ({
          splatId,
          s3Key: `splats/${splatId}/photos/${uploadStatus}-${i}.jpg`,
          originalFilename: `${uploadStatus}-${i}.jpg`,
          contentType: "image/jpeg",
          sizeBytes: 4_000_000,
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

  it("issues a thumbnail upload URL beside each photo's, outside the folder the worker downloads", async () => {
    const splat = await seedSplat();

    const res = await POST(presignRequest([photoItem("a.jpg")]), ctx(splat.id));
    const [item] = await res.json();

    const [row] = await getDb().select({ thumbnailS3Key: photos.thumbnailS3Key }).from(photos);
    expect(row.thumbnailS3Key).toBe(`splats/${splat.id}/photo-thumbnails/${item.photoId}.jpg`);
    expect(item.thumbnailPutUrl).toContain(`splats/${splat.id}/photo-thumbnails/${item.photoId}.jpg`);
  });

  it.each([
    ["without its capture time", { takenAt: undefined }],
    ["without its height", { height: undefined }],
    ["with a zero width", { width: 0 }],
    ["with a fractional height", { height: 4032.5 }],
  ])("rejects a photo sent %s", async (_label, override) => {
    const splat = await seedSplat();

    const res = await POST(presignRequest([{ ...photoItem("a.jpg"), ...override }]), ctx(splat.id));
    expect(res.status).toBe(422);
    expect(await getDb().select().from(photos)).toEqual([]);
  });

  it("404s for someone else's splat, without spending the rate limit", async () => {
    const otherUser = await getOrCreateUser("clerk-user-2");
    const [splat] = await getDb().insert(splats).values({ userId: otherUser.id, name: "not mine" }).returning();

    const res = await POST(presignRequest([photoItem("a.jpg")]), ctx(splat.id));
    expect(res.status).toBe(404);
    expect(await getDb().select().from(rateLimitCounters)).toEqual([]);
    expect(await getDb().select().from(photos)).toEqual([]);
  });

  it("charges the per-IP limit to the ALB-appended address and the per-user limit to the caller", async () => {
    const splat = await seedSplat();
    const request = new NextRequest("http://localhost/api/v1/splats/presign", {
      method: "POST",
      body: JSON.stringify([photoItem("a.jpg")]),
      headers: { "X-Forwarded-For": "1.1.1.1, 198.51.100.7" },
    });

    const res = await POST(request, ctx(splat.id));
    expect(res.status).toBe(200);

    const scopes = (await getDb().select({ scope: rateLimitCounters.scope }).from(rateLimitCounters)).map(
      row => row.scope,
    );
    expect(scopes.sort()).toEqual(["ip:198.51.100.7", `user:${splat.userId}`]);
  });
});
