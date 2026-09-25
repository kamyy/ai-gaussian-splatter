import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId: "clerk-user-1" })) }));

const { readSplatCamerasMock } = vi.hoisted(() => ({ readSplatCamerasMock: vi.fn() }));
vi.mock("@/lib/server/s3", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/server/s3")>();
  return { ...actual, readSplatCameras: readSplatCamerasMock };
});

import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { jobs, splats, users } from "@/lib/server/db/schema";
import { GET } from "./route";

function ctx(splatId: string) {
  return { params: Promise.resolve({ splatId }) } as never;
}

const POSE = {
  photoId: "p1",
  center: [0, 0, 0],
  rotation: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
};

/** Requires a real Postgres (TEST_DATABASE_URL). The S3 read is mocked so this never touches real AWS. */
describe("GET /api/v1/splats/[splatId]/cameras", () => {
  beforeEach(async () => {
    readSplatCamerasMock.mockReset();
    readSplatCamerasMock.mockResolvedValue([POSE]);
    await getDb().delete(jobs);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function seed(pointCloudS3Key: string | null, clerkUserId = "clerk-user-1") {
    const user = await getOrCreateUser(clerkUserId);
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "obj" }).returning();
    await getDb()
      .insert(jobs)
      .values({ splatId: splat.id, callbackToken: "tok", status: "awaiting_training", pointCloudS3Key });
    return splat;
  }

  it("returns the poses once the reconstruct stage has run", async () => {
    const splat = await seed("splats/x/point_cloud.ply");

    const res = await GET({} as never, ctx(splat.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([POSE]);
    expect(readSplatCamerasMock).toHaveBeenCalledWith(splat.id);
  });

  it("404s before there is a point cloud, without reading S3", async () => {
    const splat = await seed(null);

    const res = await GET({} as never, ctx(splat.id));
    expect(res.status).toBe(404);
    expect(readSplatCamerasMock).not.toHaveBeenCalled();
  });

  it("404s for a job reconstructed before the worker wrote cameras", async () => {
    readSplatCamerasMock.mockResolvedValue(null);
    const splat = await seed("splats/x/point_cloud.ply");

    const res = await GET({} as never, ctx(splat.id));
    expect(res.status).toBe(404);
  });

  it("404s for someone else's splat", async () => {
    const splat = await seed("splats/x/point_cloud.ply", "clerk-user-2");

    const res = await GET({} as never, ctx(splat.id));
    expect(res.status).toBe(404);
    expect(readSplatCamerasMock).not.toHaveBeenCalled();
  });
});
