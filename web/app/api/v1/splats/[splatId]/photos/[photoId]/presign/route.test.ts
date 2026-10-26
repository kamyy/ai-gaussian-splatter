import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "clerk-user-1" })),
  clerkClient: async () => ({ users: { getUser: async () => ({}) } }),
}));

import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { photos, splats, users } from "@/lib/server/db/schema";
import { MAX_THUMBNAIL_BYTES } from "@/lib/server/s3";
import { PhotoUploadStatus } from "@/lib/statuses";
import { POST } from "./route";

function ctx(splatId: string, photoId: string) {
  return { params: Promise.resolve({ splatId, photoId }) } as never;
}

function presignRequest(body: unknown = { thumbnailSize: 1000 }) {
  return new NextRequest("http://localhost/api/v1/splats/presign", { method: "POST", body: JSON.stringify(body) });
}

function signedHeaders(url: string): string[] {
  return new URL(url).searchParams.get("X-Amz-SignedHeaders")?.split(";") ?? [];
}

// Requires a real Postgres (TEST_DATABASE_URL). Signing an S3 URL is local, so nothing reaches AWS.
describe("POST /api/v1/splats/[splatId]/photos/[photoId]/presign", () => {
  beforeEach(async () => {
    await getDb().delete(photos);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function seedPhoto(
    overrides: Partial<typeof photos.$inferInsert> = {},
    clerkUserId = "clerk-user-1",
  ): Promise<{ splatId: string; photoId: string }> {
    const user = await getOrCreateUser(clerkUserId);
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "obj" }).returning();
    const [photo] = await getDb()
      .insert(photos)
      .values({
        splatId: splat.id,
        s3Key: `splats/${splat.id}/photos/a.jpg`,
        thumbnailS3Key: `splats/${splat.id}/photo-thumbnails/a.jpg`,
        originalFilename: "a.jpg",
        contentType: "image/jpeg",
        sizeBytes: 1234,
        uploadStatus: PhotoUploadStatus.pending,
        ...overrides,
      })
      .returning();
    return { splatId: splat.id, photoId: photo.id };
  }

  it("signs the stored keys, with each object's size signed in", async () => {
    const { splatId, photoId } = await seedPhoto();

    const res = await POST(presignRequest(), ctx(splatId, photoId));
    expect(res.status).toBe(200);

    const { photoPutUrl, thumbnailPutUrl } = await res.json();
    expect(photoPutUrl).toContain(`splats/${splatId}/photos/a.jpg`);
    expect(thumbnailPutUrl).toContain(`splats/${splatId}/photo-thumbnails/a.jpg`);
    expect(signedHeaders(photoPutUrl)).toContain("content-length");
    expect(signedHeaders(thumbnailPutUrl)).toContain("content-length");
  });

  it("rejects a thumbnail over MAX_THUMBNAIL_BYTES", async () => {
    const { splatId, photoId } = await seedPhoto();

    const res = await POST(presignRequest({ thumbnailSize: MAX_THUMBNAIL_BYTES + 1 }), ctx(splatId, photoId));
    expect(res.status).toBe(422);
  });

  it("gives no new links for a photo that is already uploaded", async () => {
    const { splatId, photoId } = await seedPhoto({ uploadStatus: PhotoUploadStatus.uploaded });

    const res = await POST(presignRequest(), ctx(splatId, photoId));
    expect(res.status).toBe(409);
  });

  it("refuses a reservation more than an hour old, so one rate-limited batch can't be re-signed forever", async () => {
    const { splatId, photoId } = await seedPhoto({ createdAt: new Date(Date.now() - 61 * 60 * 1000) });

    const res = await POST(presignRequest(), ctx(splatId, photoId));
    expect(res.status).toBe(410);
  });

  it("refuses a row the reserve route didn't create", async () => {
    const { splatId, photoId } = await seedPhoto({ thumbnailS3Key: null });

    const res = await POST(presignRequest(), ctx(splatId, photoId));
    expect(res.status).toBe(409);
  });

  it("404s for someone else's photo", async () => {
    const { splatId, photoId } = await seedPhoto({}, "clerk-user-2");

    const res = await POST(presignRequest(), ctx(splatId, photoId));
    expect(res.status).toBe(404);
  });

  it("404s for a malformed id", async () => {
    const res = await POST(presignRequest(), ctx("not-a-uuid", "also-not"));
    expect(res.status).toBe(404);
  });
});
