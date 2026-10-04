import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { deleteUserMock } = vi.hoisted(() => ({ deleteUserMock: vi.fn(async (_clerkUserId: string) => ({})) }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "clerk-user-1" })),
  clerkClient: async () => ({ users: { deleteUser: deleteUserMock } }),
}));

const { terminateWorkerMock } = vi.hoisted(() => ({ terminateWorkerMock: vi.fn(async (_instanceId: string) => {}) }));
vi.mock("@/lib/server/workerLauncher", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/server/workerLauncher")>();
  return { ...actual, terminateWorker: terminateWorkerMock };
});

const { deleteSplatObjectsMock } = vi.hoisted(() => ({
  deleteSplatObjectsMock: vi.fn(async (_splatId: string) => {}),
}));
vi.mock("@/lib/server/s3", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/server/s3")>();
  return { ...actual, deleteSplatObjects: deleteSplatObjectsMock };
});

import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { jobs, photos, rateLimitCounters, splats, users } from "@/lib/server/db/schema";
import { JobStatus, PhotoUploadStatus } from "@/lib/statuses";
import { DELETE } from "./route";

async function seedSplat(clerkUserId: string, jobStatus: JobStatus, instanceId: string) {
  const user = await getOrCreateUser(clerkUserId);
  const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "obj" }).returning();
  await getDb()
    .insert(photos)
    .values({
      splatId: splat.id,
      s3Key: `splats/${splat.id}/photos/a.jpg`,
      originalFilename: "a.jpg",
      contentType: "image/jpeg",
      uploadStatus: PhotoUploadStatus.uploaded,
    });
  await getDb()
    .insert(jobs)
    .values({ splatId: splat.id, status: jobStatus, callbackToken: "t", ec2InstanceId: instanceId });
  return { user, splat };
}

// Requires a real Postgres (TEST_DATABASE_URL). Clerk, EC2 and S3 are mocked so this never touches a real service.
describe("DELETE /api/v1/account", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await getDb().delete(rateLimitCounters);
    await getDb().delete(jobs);
    await getDb().delete(photos);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("stops running workers, deletes every row and S3 object the user owns, then deletes the Clerk user", async () => {
    const { user, splat: running } = await seedSplat("clerk-user-1", JobStatus.training_running, "i-running");
    const { splat: finished } = await seedSplat("clerk-user-1", JobStatus.complete, "i-finished");
    await getDb()
      .insert(rateLimitCounters)
      .values([
        { scope: `user:${user.id}`, windowStart: new Date(), count: 1 },
        { scope: "ip:203.0.113.5", windowStart: new Date(), count: 1 },
      ]);

    const res = await DELETE();
    expect(res.status).toBe(204);

    expect(terminateWorkerMock.mock.calls).toEqual([["i-running"]]);
    expect(deleteSplatObjectsMock.mock.calls.map(([id]) => id).sort()).toEqual([running.id, finished.id].sort());
    expect(deleteUserMock).toHaveBeenCalledWith("clerk-user-1");
    expect(await getDb().select().from(users)).toHaveLength(0);
    expect(await getDb().select().from(splats)).toHaveLength(0);
    expect(await getDb().select().from(photos)).toHaveLength(0);
    expect(await getDb().select().from(jobs)).toHaveLength(0);
    expect((await getDb().select().from(rateLimitCounters)).map(row => row.scope)).toEqual(["ip:203.0.113.5"]);
  });

  it("leaves other users' rows alone", async () => {
    await seedSplat("clerk-user-1", JobStatus.complete, "i-mine");
    const { user: other, splat: theirs } = await seedSplat("clerk-user-2", JobStatus.training_running, "i-theirs");

    await DELETE();

    expect(terminateWorkerMock).not.toHaveBeenCalled();
    expect(await getDb().select().from(users)).toEqual([expect.objectContaining({ id: other.id })]);
    expect(await getDb().select().from(splats)).toEqual([expect.objectContaining({ id: theirs.id })]);
    expect(await getDb().select().from(jobs).where(eq(jobs.splatId, theirs.id))).toHaveLength(1);
  });

  it("deletes nothing when a worker can't be stopped", async () => {
    terminateWorkerMock.mockRejectedValueOnce(new Error("UnauthorizedOperation"));
    await seedSplat("clerk-user-1", JobStatus.training_running, "i-running");

    await expect(DELETE()).rejects.toThrow("UnauthorizedOperation");
    expect(await getDb().select().from(splats)).toHaveLength(1);
    expect(deleteSplatObjectsMock).not.toHaveBeenCalled();
    expect(deleteUserMock).not.toHaveBeenCalled();
  });

  it("removes a user row that another tab's request recreated before Clerk deleted the user", async () => {
    await seedSplat("clerk-user-1", JobStatus.complete, "i-finished");
    deleteUserMock.mockImplementationOnce(async clerkUserId => {
      await getOrCreateUser(clerkUserId);
      return {};
    });

    const res = await DELETE();
    expect(res.status).toBe(204);
    expect(await getDb().select().from(users)).toHaveLength(0);
  });

  it("still deletes the Clerk user when the app has no row for them", async () => {
    const res = await DELETE();
    expect(res.status).toBe(204);
    expect(deleteUserMock).toHaveBeenCalledWith("clerk-user-1");
  });

  it("succeeds when Clerk has already deleted the user", async () => {
    deleteUserMock.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));

    const res = await DELETE();
    expect(res.status).toBe(204);
  });

  it("still deletes the rows and the Clerk user when S3 cleanup fails", async () => {
    deleteSplatObjectsMock.mockRejectedValueOnce(new Error("AccessDenied"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await seedSplat("clerk-user-1", JobStatus.complete, "i-finished");

    const res = await DELETE();
    expect(res.status).toBe(204);
    expect(await getDb().select().from(splats)).toHaveLength(0);
    expect(deleteUserMock).toHaveBeenCalledWith("clerk-user-1");
  });
});
