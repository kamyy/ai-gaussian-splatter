import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getPublicSplat, getPublicSplatView } from "../data";
import { closeDb, getDb } from "../db";
import { jobs, photos, splats, users } from "../db/schema";

// Requires a real Postgres (TEST_DATABASE_URL). getPublicSplat is the only gate between the unauthenticated share page
// and a splat, so every way a splat can fail to qualify is checked here. Signing an S3 URL is local, so nothing reaches
// AWS.
afterAll(async () => {
  await closeDb();
});

describe("getPublicSplat", () => {
  beforeEach(async () => {
    await getDb().delete(jobs);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  async function seedShared() {
    const [user] = await getDb().insert(users).values({ clerkUserId: "u1" }).returning();
    const [splat] = await getDb()
      .insert(splats)
      .values({ userId: user.id, name: "Mug", status: "complete", thumbnailS3Key: "splats/x/thumbnail.jpg" })
      .returning();
    const [job] = await getDb()
      .insert(jobs)
      .values({ splatId: splat.id, callbackToken: "tok", status: "complete", resultSpzS3Key: "splats/x/result.spz" })
      .returning();
    return { splat, job };
  }

  it("returns the title and signed URLs for a complete, shareable splat", async () => {
    const { splat } = await seedShared();

    const result = await getPublicSplat(splat.id);

    expect(result?.title).toBe("Mug");
    expect(result?.thumbnailUrl).toContain("splats/x/thumbnail.jpg");
    expect(result?.splatUrl).toContain("splats/x/result.spz");
  });

  it("hides a splat its owner hasn't made shareable", async () => {
    const { splat } = await seedShared();
    await getDb().update(splats).set({ isShareable: false }).where(eq(splats.id, splat.id));

    expect(await getPublicSplat(splat.id)).toBeNull();
  });

  it("hides a splat that isn't complete", async () => {
    const { splat } = await seedShared();
    await getDb().update(splats).set({ status: "processing" }).where(eq(splats.id, splat.id));

    expect(await getPublicSplat(splat.id)).toBeNull();
  });

  it("hides a splat with no preview thumbnail", async () => {
    const { splat } = await seedShared();
    await getDb().update(splats).set({ thumbnailS3Key: null }).where(eq(splats.id, splat.id));

    expect(await getPublicSplat(splat.id)).toBeNull();
  });

  it("hides a splat whose completed job has no .spz", async () => {
    const { splat, job } = await seedShared();
    await getDb().update(jobs).set({ resultSpzS3Key: null }).where(eq(jobs.id, job.id));

    expect(await getPublicSplat(splat.id)).toBeNull();
  });

  it("serves the newest completed job's .spz", async () => {
    const { splat, job } = await seedShared();
    await getDb()
      .update(jobs)
      .set({ createdAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(jobs.id, job.id));
    await getDb()
      .insert(jobs)
      .values({
        splatId: splat.id,
        callbackToken: "tok-2",
        status: "complete",
        resultSpzS3Key: "splats/x/retrained.spz",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      });

    expect((await getPublicSplat(splat.id))?.splatUrl).toContain("splats/x/retrained.spz");
  });

  it("returns null for a malformed id without querying", async () => {
    expect(await getPublicSplat("not-a-uuid")).toBeNull();
  });

  it("links the point cloud when the job kept one", async () => {
    const { splat, job } = await seedShared();
    expect((await getPublicSplat(splat.id))?.pointCloudUrl).toBeNull();

    await getDb().update(jobs).set({ pointCloudS3Key: "splats/x/points.ply" }).where(eq(jobs.id, job.id));

    expect((await getPublicSplat(splat.id))?.pointCloudUrl).toContain("splats/x/points.ply");
  });
});

describe("getPublicSplatView", () => {
  beforeEach(async () => {
    await getDb().delete(photos);
    await getDb().delete(jobs);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  async function seedSplat(isShareable: boolean) {
    const [user] = await getDb().insert(users).values({ clerkUserId: "u1" }).returning();
    const [splat] = await getDb()
      .insert(splats)
      .values({
        userId: user.id,
        name: "Mug",
        status: "complete",
        thumbnailS3Key: "splats/x/thumbnail.jpg",
        isShareable,
      })
      .returning();
    await getDb()
      .insert(jobs)
      .values({ splatId: splat.id, callbackToken: "tok", status: "complete", resultSpzS3Key: "splats/x/result.spz" });
    return splat;
  }

  function photo(splatId: string, name: string, overrides: Partial<typeof photos.$inferInsert> = {}) {
    return {
      splatId,
      s3Key: `splats/x/photos/${name}.jpg`,
      originalFilename: `${name}.jpg`,
      contentType: "image/jpeg",
      thumbnailS3Key: `splats/x/photo-thumbnails/${name}.jpg`,
      uploadStatus: "uploaded" as const,
      ...overrides,
    };
  }

  it("returns null for a splat that isn't public", async () => {
    const splat = await seedSplat(false);
    await getDb().insert(photos).values(photo(splat.id, "a"));

    expect(await getPublicSplatView(splat.id)).toBeNull();
  });

  it("lists uploaded photos with thumbnails, oldest taken first, under stand-in names", async () => {
    const splat = await seedSplat(true);
    await getDb()
      .insert(photos)
      .values([
        photo(splat.id, "late", { takenAt: new Date("2026-01-02T00:00:00Z") }),
        photo(splat.id, "early", { takenAt: new Date("2026-01-01T00:00:00Z") }),
        photo(splat.id, "legacy", { thumbnailS3Key: null }),
        photo(splat.id, "pending", { uploadStatus: "pending" }),
      ]);

    const view = await getPublicSplatView(splat.id);

    expect(view?.photos.map(p => p.originalFilename)).toEqual(["Photo 1", "Photo 2"]);
    expect(view?.photos[0].thumbnailUrl).toContain("photo-thumbnails/early.jpg");
    expect(view?.photos[1].thumbnailUrl).toContain("photo-thumbnails/late.jpg");
  });

  it("never links an original photo", async () => {
    const splat = await seedSplat(true);
    await getDb()
      .insert(photos)
      .values([photo(splat.id, "a"), photo(splat.id, "legacy", { thumbnailS3Key: null })]);

    const view = await getPublicSplatView(splat.id);

    expect(view?.photos).toHaveLength(1);
    expect(JSON.stringify(view)).not.toContain("splats/x/photos/");
  });
});
