import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/lib/server/db";
import { jobs, splats, users } from "@/lib/server/db/schema";
import { GET } from "./route";

function ctx(splatId: string) {
  return { params: Promise.resolve({ splatId }) } as never;
}

// Requires a real Postgres (TEST_DATABASE_URL). No Clerk mock: this route is public. What qualifies a splat is
// web/lib/server/tests/data.test.ts's subject, so this only checks the route's two responses.
describe("GET /api/v1/public/splats/[splatId]", () => {
  beforeEach(async () => {
    await getDb().delete(jobs);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function seed(isShareable: boolean) {
    const [user] = await getDb().insert(users).values({ clerkUserId: "u1" }).returning();
    const [splat] = await getDb()
      .insert(splats)
      .values({ userId: user.id, name: "Mug", status: "complete", thumbnailS3Key: "t.jpg", isShareable })
      .returning();
    await getDb()
      .insert(jobs)
      .values({ splatId: splat.id, callbackToken: "tok", status: "complete", resultSpzS3Key: "r.spz" });
    return splat;
  }

  it("serves a shareable splat to anyone", async () => {
    const splat = await seed(true);

    const res = await GET({} as never, ctx(splat.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: "Mug" });
  });

  it("404s for a splat that isn't shareable", async () => {
    const splat = await seed(false);

    const res = await GET({} as never, ctx(splat.id));
    expect(res.status).toBe(404);
  });
});
