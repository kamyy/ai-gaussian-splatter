import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "clerk-user-1" })),
  clerkClient: async () => ({ users: { getUser: async () => ({}) } }),
}));

// Each test sets the stored size of the photo and its thumbnail by key. A key with no entry has no object.
const { objectSizes, deleteUploadedObjectMock } = vi.hoisted(() => ({
  objectSizes: new Map<string, number>(),
  deleteUploadedObjectMock: vi.fn(async (_key: string) => {}),
}));
vi.mock("@/lib/server/s3", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/server/s3")>();
  return {
    ...actual,
    uploadedObjectSize: async (key: string) => objectSizes.get(key) ?? null,
    deleteUploadedObject: deleteUploadedObjectMock,
  };
});

import { MAX_PHOTO_BYTES } from "@/lib/limits";
import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { photos, splats, users } from "@/lib/server/db/schema";
import { MAX_THUMBNAIL_BYTES } from "@/lib/server/s3";
import { POST } from "./route";

function ctx(splatId: string, photoId: string) {
  return { params: Promise.resolve({ splatId, photoId }) } as never;
}

function completeRequest() {
  return new NextRequest("http://localhost/api/v1/splats/complete", { method: "POST" });
}

// Requires a real Postgres (TEST_DATABASE_URL). S3 is mocked so this never touches real AWS.
describe("POST /api/v1/splats/[splatId]/photos/[photoId]/complete", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    objectSizes.clear();
    await getDb().delete(photos);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function seedPhoto(clerkUserId = "clerk-user-1") {
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
        width: 3024,
        height: 4032,
        uploadStatus: "pending",
      })
      .returning();
    return { ...photo, thumbnailS3Key: photo.thumbnailS3Key as string };
  }

  async function uploadStatus() {
    const [row] = await getDb().select({ uploadStatus: photos.uploadStatus }).from(photos);
    return row.uploadStatus;
  }

  it("marks a photo and thumbnail within their caps uploaded", async () => {
    const photo = await seedPhoto();
    objectSizes.set(photo.s3Key, MAX_PHOTO_BYTES);
    objectSizes.set(photo.thumbnailS3Key, MAX_THUMBNAIL_BYTES);

    const res = await POST(completeRequest(), ctx(photo.splatId, photo.id));

    expect(res.status).toBe(204);
    expect(await uploadStatus()).toBe("uploaded");
  });

  it("404s for a photo on someone else's splat, leaving it pending", async () => {
    const photo = await seedPhoto("clerk-user-2");
    objectSizes.set(photo.s3Key, 4_000_000);
    objectSizes.set(photo.thumbnailS3Key, 100_000);

    const res = await POST(completeRequest(), ctx(photo.splatId, photo.id));

    expect(res.status).toBe(404);
    expect(await uploadStatus()).toBe("pending");
  });

  it("404s for a photo addressed through a different splat of the caller's", async () => {
    const photo = await seedPhoto();
    objectSizes.set(photo.s3Key, 4_000_000);
    objectSizes.set(photo.thumbnailS3Key, 100_000);
    const user = await getOrCreateUser("clerk-user-1");
    const [otherSplat] = await getDb().insert(splats).values({ userId: user.id, name: "other" }).returning();

    const res = await POST(completeRequest(), ctx(otherSplat.id, photo.id));

    expect(res.status).toBe(404);
    expect(await uploadStatus()).toBe("pending");
  });

  it("deletes a photo over MAX_PHOTO_BYTES and leaves it pending", async () => {
    const photo = await seedPhoto();
    objectSizes.set(photo.s3Key, MAX_PHOTO_BYTES + 1);
    objectSizes.set(photo.thumbnailS3Key, 100_000);

    const res = await POST(completeRequest(), ctx(photo.splatId, photo.id));

    expect(res.status).toBe(400);
    expect(deleteUploadedObjectMock).toHaveBeenCalledWith(photo.s3Key);
    expect(await uploadStatus()).toBe("pending");
  });

  it("deletes a thumbnail over MAX_THUMBNAIL_BYTES and leaves the photo pending", async () => {
    const photo = await seedPhoto();
    objectSizes.set(photo.s3Key, 4_000_000);
    objectSizes.set(photo.thumbnailS3Key, MAX_THUMBNAIL_BYTES + 1);

    const res = await POST(completeRequest(), ctx(photo.splatId, photo.id));

    expect(res.status).toBe(400);
    expect(deleteUploadedObjectMock).toHaveBeenCalledWith(photo.thumbnailS3Key);
    expect(await uploadStatus()).toBe("pending");
  });

  it("refuses a photo whose object was never uploaded", async () => {
    const photo = await seedPhoto();
    objectSizes.set(photo.thumbnailS3Key, 100_000);

    const res = await POST(completeRequest(), ctx(photo.splatId, photo.id));

    expect(res.status).toBe(400);
    expect(await uploadStatus()).toBe("pending");
  });

  it("refuses a photo whose thumbnail was never uploaded", async () => {
    const photo = await seedPhoto();
    objectSizes.set(photo.s3Key, 4_000_000);

    const res = await POST(completeRequest(), ctx(photo.splatId, photo.id));

    expect(res.status).toBe(400);
    expect(await uploadStatus()).toBe("pending");
  });
});
