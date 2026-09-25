import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId: "clerk-user-1" })) }));

const { terminateWorkerMock } = vi.hoisted(() => ({ terminateWorkerMock: vi.fn(async () => {}) }));
vi.mock("@/lib/server/ec2Launcher", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/server/ec2Launcher")>();
  return { ...actual, terminateWorker: terminateWorkerMock, localLaunchEnabled: () => false };
});

const { deleteSplatObjectsMock } = vi.hoisted(() => ({ deleteSplatObjectsMock: vi.fn(async () => {}) }));
vi.mock("@/lib/server/s3", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/server/s3")>();
  return { ...actual, deleteSplatObjects: deleteSplatObjectsMock };
});

import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { jobs, photos, splats, users } from "@/lib/server/db/schema";
import { DELETE } from "./route";

function ctx(splatId: string) {
  return { params: Promise.resolve({ splatId }) } as never;
}

/** Requires a real Postgres (TEST_DATABASE_URL). EC2 and S3 are mocked so this never touches real AWS. */
describe("DELETE /api/v1/splats/[splatId]", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await getDb().delete(jobs);
    await getDb().delete(photos);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function seed(clerkUserId = "clerk-user-1") {
    const user = await getOrCreateUser(clerkUserId);
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "obj" }).returning();
    await getDb()
      .insert(photos)
      .values({
        splatId: splat.id,
        s3Key: `splats/${splat.id}/photos/a.jpg`,
        originalFilename: "a.jpg",
        contentType: "image/jpeg",
        uploadStatus: "uploaded",
      });
    await getDb()
      .insert(jobs)
      .values({ splatId: splat.id, status: "training_running", callbackToken: "t", ec2InstanceId: "i-0abc123" });
    return splat;
  }

  it("stops the running worker, then removes the splat's rows and its S3 objects", async () => {
    const splat = await seed();

    const res = await DELETE({} as never, ctx(splat.id));
    expect(res.status).toBe(204);
    expect(terminateWorkerMock).toHaveBeenCalledWith("i-0abc123");
    expect(deleteSplatObjectsMock).toHaveBeenCalledWith(splat.id);
    expect(await getDb().select().from(splats).where(eq(splats.id, splat.id))).toHaveLength(0);
    expect(await getDb().select().from(photos).where(eq(photos.splatId, splat.id))).toHaveLength(0);
    expect(await getDb().select().from(jobs).where(eq(jobs.splatId, splat.id))).toHaveLength(0);
  });

  it("still reports success when S3 cleanup fails, since the splat itself is gone", async () => {
    deleteSplatObjectsMock.mockRejectedValueOnce(new Error("AccessDenied"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const splat = await seed();

    const res = await DELETE({} as never, ctx(splat.id));
    expect(res.status).toBe(204);
    expect(await getDb().select().from(splats).where(eq(splats.id, splat.id))).toHaveLength(0);
  });

  it("keeps the splat when its worker can't be stopped", async () => {
    terminateWorkerMock.mockRejectedValueOnce(new Error("UnauthorizedOperation"));
    const splat = await seed();

    await expect(DELETE({} as never, ctx(splat.id))).rejects.toThrow("UnauthorizedOperation");
    expect(await getDb().select().from(splats).where(eq(splats.id, splat.id))).toHaveLength(1);
    expect(deleteSplatObjectsMock).not.toHaveBeenCalled();
  });

  it("404s for someone else's splat and deletes nothing", async () => {
    const splat = await seed("clerk-user-2");

    const res = await DELETE({} as never, ctx(splat.id));
    expect(res.status).toBe(404);
    expect(await getDb().select().from(splats).where(eq(splats.id, splat.id))).toHaveLength(1);
  });
});
