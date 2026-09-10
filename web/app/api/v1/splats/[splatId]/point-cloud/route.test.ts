import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId: "clerk-user-1" })) }));

import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { jobs, splats, users } from "@/lib/server/db/schema";
import type { JobStatus } from "@/lib/types";
import { GET } from "./route";

const hasPostgres = Boolean(process.env.TEST_DATABASE_URL);

function ctx(splatId: string) {
  return { params: Promise.resolve({ splatId }) } as never;
}

describe.skipIf(!hasPostgres)("GET /api/v1/splats/[splatId]/point-cloud", () => {
  beforeEach(async () => {
    await getDb().delete(jobs);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function seed(jobStatus: JobStatus, pointCloudS3Key: string | null) {
    const user = await getOrCreateUser("clerk-user-1");
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "obj" }).returning();
    const [job] = await getDb()
      .insert(jobs)
      .values({ splatId: splat.id, callbackToken: "tok", status: jobStatus, pointCloudS3Key })
      .returning();
    return { user, splat, job };
  }

  it("404s before the reconstruct phase has produced a point cloud key", async () => {
    const { splat } = await seed("colmap_running", null);

    const res = await GET({} as never, ctx(splat.id));
    expect(res.status).toBe(404);
  });

  it("404s for a splat the caller doesn't own", async () => {
    const res = await GET({} as never, ctx("11111111-1111-4111-8111-111111111111"));
    expect(res.status).toBe(404);
  });

  it("200s once the key is set, while still awaiting training", async () => {
    const { splat } = await seed("awaiting_training", "splats/x/point_cloud.ply");

    const res = await GET({} as never, ctx(splat.id));
    expect(res.status).toBe(200);
    const url = await res.json();
    expect(url).toContain("point_cloud.ply");
  });

  it("stays 200 once the job later reaches complete — the key is never cleared", async () => {
    const { splat } = await seed("complete", "splats/x/point_cloud.ply");

    const res = await GET({} as never, ctx(splat.id));
    expect(res.status).toBe(200);
  });
});
