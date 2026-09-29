import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getPublicSplat } from "../data";
import { closeDb, getDb } from "../db";
import { jobs, splats, users } from "../db/schema";

// Requires a real Postgres (TEST_DATABASE_URL). getPublicSplat is the only gate between the unauthenticated share page
// and a splat, so every way a splat can fail to qualify is checked here. Signing an S3 URL is local, so nothing reaches
// AWS.
describe("getPublicSplat", () => {
  beforeEach(async () => {
    await getDb().delete(jobs);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  afterAll(async () => {
    await closeDb();
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
});
