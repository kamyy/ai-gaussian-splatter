import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { JobStatus, PhotoUploadStatus, SplatStatus } from "@/lib/statuses";
import type { CropBox } from "@/lib/types";
import { getExampleSplats, getPublicSplat, getPublicSplatView } from "../data";
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
      .values({ userId: user.id, name: "Mug", status: SplatStatus.complete, thumbnailS3Key: "splats/x/thumbnail.jpg" })
      .returning();
    const [job] = await getDb()
      .insert(jobs)
      .values({
        splatId: splat.id,
        callbackToken: "tok",
        status: JobStatus.complete,
        resultSpzS3Key: "splats/x/result.spz",
      })
      .returning();
    return { splat, job };
  }

  it("returns the title and signed URLs for a complete, shareable splat", async () => {
    const { splat } = await seedShared();

    const result = await getPublicSplat(splat.id);

    expect(result?.title).toBe("Mug");
    expect(result?.isShowcase).toBe(false);
    expect(result?.thumbnailUrl).toContain("splats/x/thumbnail.jpg");
    expect(result?.splatUrl).toContain("splats/x/result.spz");
  });

  it("serves the owner's crop, when there is one", async () => {
    const { splat, job } = await seedShared();
    const cropBox: CropBox = { center: [1, 2, 3], size: [1, 1, 1], quaternion: [0, 0, 0, 1] };
    await getDb()
      .update(jobs)
      .set({ cropBox, croppedResultSpzS3Key: "splats/x/crops/c1/result.spz" })
      .where(eq(jobs.id, job.id));

    const result = await getPublicSplat(splat.id);
    expect(result?.splatUrl).toContain("splats/x/crops/c1/result.spz");
    expect(result?.cropBox).toEqual(cropBox);
  });

  it("marks a splat owned by the showcase account", async () => {
    const { splat } = await seedShared();
    await getDb().update(users).set({ clerkUserId: "showcase" }).where(eq(users.id, splat.userId));

    expect((await getPublicSplat(splat.id))?.isShowcase).toBe(true);
  });

  it("hides a splat its owner hasn't made shareable", async () => {
    const { splat } = await seedShared();
    await getDb().update(splats).set({ isShareable: false }).where(eq(splats.id, splat.id));

    expect(await getPublicSplat(splat.id)).toBeNull();
  });

  it("hides a splat that isn't complete", async () => {
    const { splat } = await seedShared();
    await getDb().update(splats).set({ status: SplatStatus.processing }).where(eq(splats.id, splat.id));

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
        status: JobStatus.complete,
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
        status: SplatStatus.complete,
        thumbnailS3Key: "splats/x/thumbnail.jpg",
        isShareable,
      })
      .returning();
    await getDb().insert(jobs).values({
      splatId: splat.id,
      callbackToken: "tok",
      status: JobStatus.complete,
      resultSpzS3Key: "splats/x/result.spz",
    });
    return splat;
  }

  function photo(splatId: string, name: string, overrides: Partial<typeof photos.$inferInsert> = {}) {
    return {
      splatId,
      s3Key: `splats/x/photos/${name}.jpg`,
      originalFilename: `${name}.jpg`,
      contentType: "image/jpeg",
      thumbnailS3Key: `splats/x/photo-thumbnails/${name}.jpg`,
      uploadStatus: PhotoUploadStatus.uploaded,
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
        photo(splat.id, "pending", { uploadStatus: PhotoUploadStatus.pending }),
      ]);

    const view = await getPublicSplatView(splat.id);

    expect(view?.photos.map(p => p.originalFilename)).toEqual(["Photo 1", "Photo 2"]);
    expect(view?.photos[0].thumbnailUrl).toContain("photo-thumbnails/early.jpg");
    expect(view?.photos[1].thumbnailUrl).toContain("photo-thumbnails/late.jpg");
  });

  it("returns the complete job's stage timestamps", async () => {
    const splat = await seedSplat(true);
    const colmapFinishedAt = new Date("2026-01-01T10:07:52Z");
    await getDb().update(jobs).set({ colmapFinishedAt }).where(eq(jobs.splatId, splat.id));

    const view = await getPublicSplatView(splat.id);

    expect(view?.timestamps.colmapFinishedAt).toBe(colmapFinishedAt.toISOString());
    expect(view?.timestamps.colmapBootedAt).toBeNull();
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

describe("getExampleSplats", () => {
  beforeEach(async () => {
    await getDb().delete(photos);
    await getDb().delete(jobs);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  async function seedUser(clerkUserId: string) {
    const [user] = await getDb().insert(users).values({ clerkUserId }).returning();
    return user;
  }

  async function seedExample(userId: string, name: string, overrides: Partial<typeof splats.$inferInsert> = {}) {
    const [splat] = await getDb()
      .insert(splats)
      .values({
        userId,
        name,
        status: SplatStatus.complete,
        thumbnailS3Key: `splats/${name}/thumbnail.jpg`,
        ...overrides,
      })
      .returning();
    await getDb()
      .insert(jobs)
      .values({
        splatId: splat.id,
        callbackToken: `tok-${name}`,
        status: JobStatus.complete,
        resultSpzS3Key: `splats/${name}/result.spz`,
      });
    return splat;
  }

  it("lists only the showcase account's splats that the share page would serve", async () => {
    const owner = await seedUser("showcase");
    const other = await seedUser("someone-else");
    await seedExample(owner.id, "shown");
    await seedExample(owner.id, "private", { isShareable: false });
    await seedExample(owner.id, "processing", { status: SplatStatus.processing });
    await seedExample(owner.id, "no-preview", { thumbnailS3Key: null });
    await seedExample(other.id, "not-theirs");
    const [noSpz] = await getDb()
      .insert(splats)
      .values({
        userId: owner.id,
        name: "no-spz",
        status: SplatStatus.complete,
        thumbnailS3Key: "splats/no-spz/thumbnail.jpg",
      })
      .returning();
    await getDb().insert(jobs).values({ splatId: noSpz.id, callbackToken: "tok-no-spz", status: JobStatus.complete });

    const examples = await getExampleSplats("showcase");

    expect(examples.map(example => example.name)).toEqual(["shown"]);
  });

  it("judges a splat by its newest complete job's .spz, as the share page does", async () => {
    const owner = await seedUser("showcase");
    const splat = await seedExample(owner.id, "retrained");
    await getDb()
      .update(jobs)
      .set({ createdAt: new Date("2026-01-01T00:00:00Z") })
      .where(eq(jobs.splatId, splat.id));
    await getDb()
      .insert(jobs)
      .values({
        splatId: splat.id,
        callbackToken: "tok-newer",
        status: JobStatus.complete,
        createdAt: new Date("2026-01-02T00:00:00Z"),
      });

    expect(await getPublicSplat(splat.id)).toBeNull();
    expect(await getExampleSplats("showcase")).toEqual([]);
  });

  it("lists the newest eight, newest first", async () => {
    const owner = await seedUser("showcase");
    for (let day = 1; day <= 10; day++) {
      await seedExample(owner.id, `day-${day}`, { createdAt: new Date(`2026-01-${String(day).padStart(2, "0")}`) });
    }

    const examples = await getExampleSplats("showcase");

    expect(examples.map(example => example.name)).toEqual([
      "day-10",
      "day-9",
      "day-8",
      "day-7",
      "day-6",
      "day-5",
      "day-4",
      "day-3",
    ]);
  });

  it("marks only the listed examples as showcase splats on the share page", async () => {
    const owner = await seedUser("showcase");
    const splatsByDay = [];
    for (let day = 1; day <= 10; day++) {
      splatsByDay.push(
        await seedExample(owner.id, `day-${day}`, { createdAt: new Date(`2026-01-${String(day).padStart(2, "0")}`) }),
      );
    }

    expect((await getPublicSplat(splatsByDay[9].id))?.isShowcase).toBe(true);
    expect((await getPublicSplat(splatsByDay[0].id))?.isShowcase).toBe(false);
  });

  it("covers each card with the first photo's thumbnail and counts only photos with one", async () => {
    const owner = await seedUser("showcase");
    const splat = await seedExample(owner.id, "mug");
    const photo = (name: string, overrides: Partial<typeof photos.$inferInsert> = {}) => ({
      splatId: splat.id,
      s3Key: `splats/mug/photos/${name}.jpg`,
      originalFilename: `${name}.jpg`,
      contentType: "image/jpeg",
      thumbnailS3Key: `splats/mug/photo-thumbnails/${name}.jpg`,
      uploadStatus: PhotoUploadStatus.uploaded,
      ...overrides,
    });
    await getDb()
      .insert(photos)
      .values([
        photo("late", { takenAt: new Date("2026-01-02T00:00:00Z") }),
        photo("early", { takenAt: new Date("2026-01-01T00:00:00Z"), width: 3024, height: 4032 }),
        photo("legacy", { thumbnailS3Key: null, takenAt: new Date("2025-12-31T00:00:00Z") }),
        photo("pending", { uploadStatus: PhotoUploadStatus.pending }),
      ]);

    const [example] = await getExampleSplats("showcase");

    expect(example.photoCount).toBe(2);
    expect(example.thumbnailPhotoUrl).toContain("photo-thumbnails/early.jpg");
    expect(example).toMatchObject({ thumbnailWidth: 3024, thumbnailHeight: 4032 });
    expect(JSON.stringify(example)).not.toContain("splats/mug/photos/");
  });

  it("leaves the cover empty for a splat with no photo thumbnails", async () => {
    const owner = await seedUser("showcase");
    await seedExample(owner.id, "bare");

    const [example] = await getExampleSplats("showcase");

    expect(example).toMatchObject({ photoCount: 0, thumbnailPhotoUrl: null, thumbnailWidth: null });
  });

  it("returns nothing for an account with no row yet", async () => {
    expect(await getExampleSplats("never-signed-in")).toEqual([]);
  });
});
