import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId: "clerk-user-1" })) }));

const { terminateWorkerMock } = vi.hoisted(() => ({ terminateWorkerMock: vi.fn(async () => {}) }));
vi.mock("@/lib/server/ec2Launcher", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/server/ec2Launcher")>();
  return { ...actual, terminateWorker: terminateWorkerMock, localLaunchEnabled: () => false };
});

import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { jobs, splats, users } from "@/lib/server/db/schema";
import type { JobStatus } from "@/lib/types";
import { POST } from "./route";

function ctx(splatId: string) {
  return { params: Promise.resolve({ splatId }) } as never;
}

/** Requires a real Postgres (TEST_DATABASE_URL). terminateWorker is mocked so this never touches real AWS. */
describe("POST /api/v1/splats/[splatId]/cancel", () => {
  beforeEach(async () => {
    terminateWorkerMock.mockClear();
    terminateWorkerMock.mockResolvedValue(undefined);
    await getDb().delete(jobs);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function seed(status: JobStatus | null, clerkUserId = "clerk-user-1") {
    const user = await getOrCreateUser(clerkUserId);
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "obj" }).returning();
    const [job] =
      status === null
        ? [undefined]
        : await getDb()
            .insert(jobs)
            .values({ splatId: splat.id, status, callbackToken: "t", ec2InstanceId: "i-0abc123" })
            .returning();
    return { splat, job };
  }

  it("terminates a running worker and marks its job cancelled", async () => {
    const { splat, job } = await seed("training_running");

    const res = await POST({} as never, ctx(splat.id));
    expect(res.status).toBe(200);
    expect(terminateWorkerMock).toHaveBeenCalledWith("i-0abc123");
    const [row] = await getDb()
      .select()
      .from(jobs)
      .where(eq(jobs.id, job?.id ?? ""));
    expect(row.status).toBe("cancelled");
  });

  it("cancels a job paused for review without terminating anything", async () => {
    const { splat } = await seed("awaiting_training");

    const res = await POST({} as never, ctx(splat.id));
    expect(res.status).toBe(200);
    expect(terminateWorkerMock).not.toHaveBeenCalled();
  });

  it("leaves the job running when the worker can't be stopped", async () => {
    terminateWorkerMock.mockRejectedValueOnce(new Error("UnauthorizedOperation"));
    const { splat, job } = await seed("reconstruction_running");

    await expect(POST({} as never, ctx(splat.id))).rejects.toThrow("UnauthorizedOperation");
    const [row] = await getDb()
      .select()
      .from(jobs)
      .where(eq(jobs.id, job?.id ?? ""));
    expect(row.status).toBe("reconstruction_running");
  });

  it("409s when nothing is running", async () => {
    const { splat } = await seed("complete");

    const res = await POST({} as never, ctx(splat.id));
    expect(res.status).toBe(409);
  });

  it("404s for someone else's splat", async () => {
    const { splat } = await seed("training_running", "clerk-user-2");

    const res = await POST({} as never, ctx(splat.id));
    expect(res.status).toBe(404);
    expect(terminateWorkerMock).not.toHaveBeenCalled();
  });
});
