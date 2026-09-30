import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { describeWorkerMock, terminateWorkerMock } = vi.hoisted(() => ({
  describeWorkerMock: vi.fn(
    async (_id: string): Promise<{ state: string; launchTime: Date; maxLifetimeMinutes: number | null } | null> => null,
  ),
  terminateWorkerMock: vi.fn(async (_id: string) => {}),
}));
vi.mock("@/lib/server/ec2Launcher", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/server/ec2Launcher")>();
  return {
    ...actual,
    describeWorker: describeWorkerMock,
    terminateWorker: terminateWorkerMock,
    localLaunchEnabled: () => false,
  };
});

import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { jobs, splats, users } from "@/lib/server/db/schema";
import type { JobStatus } from "@/lib/statuses";
import { reconcileJob } from "../reconcileJob";

const MINUTE = 60 * 1000;

// Requires a real Postgres (TEST_DATABASE_URL). EC2 is mocked so this never touches real AWS.
describe("reconcileJob", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await getDb().delete(jobs);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function seed(status: JobStatus, lastCallbackMinutesAgo: number) {
    const user = await getOrCreateUser("clerk-user-1");
    const [splat] = await getDb()
      .insert(splats)
      .values({ userId: user.id, name: "obj", status: "processing" })
      .returning();
    const [job] = await getDb()
      .insert(jobs)
      .values({
        splatId: splat.id,
        status,
        callbackToken: "t",
        ec2InstanceId: "i-0abc123",
        updatedAt: new Date(Date.now() - lastCallbackMinutesAgo * MINUTE),
      })
      .returning();
    return job;
  }

  async function statuses() {
    const [row] = await getDb()
      .select({ job: jobs.status, splat: splats.status, errorMessage: jobs.errorMessage })
      .from(jobs)
      .innerJoin(splats, eq(jobs.splatId, splats.id));
    return row;
  }

  it("leaves a job alone while its callbacks are recent, without looking the instance up", async () => {
    const job = await seed("reconstruction_running", 5);

    expect(await reconcileJob(job)).toBe(false);
    expect(describeWorkerMock).not.toHaveBeenCalled();
  });

  it("leaves a quiet job alone while its instance is running inside the ceiling", async () => {
    const job = await seed("reconstruction_running", 30);
    describeWorkerMock.mockResolvedValueOnce({
      state: "running",
      launchTime: new Date(Date.now() - 20 * MINUTE),
      maxLifetimeMinutes: 30,
    });

    expect(await reconcileJob(job)).toBe(false);
    expect((await statuses()).job).toBe("reconstruction_running");
  });

  it("fails a job whose instance has terminated", async () => {
    const job = await seed("training_running", 30);
    describeWorkerMock.mockResolvedValueOnce({
      state: "terminated",
      launchTime: new Date(Date.now() - 40 * MINUTE),
      maxLifetimeMinutes: 30,
    });

    expect(await reconcileJob(job)).toBe(true);
    expect(await statuses()).toEqual({
      job: "failed",
      splat: "failed",
      errorMessage: "The worker stopped without reporting a result.",
    });
    expect(terminateWorkerMock).not.toHaveBeenCalled();
  });

  it("fails a job whose instance EC2 no longer knows about", async () => {
    const job = await seed("launching", 30);
    describeWorkerMock.mockResolvedValueOnce(null);

    expect(await reconcileJob(job)).toBe(true);
    expect((await statuses()).job).toBe("failed");
  });

  it("terminates an instance running past its own ceiling and fails its job", async () => {
    const job = await seed("training_running", 30);
    describeWorkerMock.mockResolvedValueOnce({
      state: "running",
      launchTime: new Date(Date.now() - 60 * MINUTE),
      maxLifetimeMinutes: 30,
    });

    expect(await reconcileJob(job)).toBe(true);
    expect(terminateWorkerMock).toHaveBeenCalledWith("i-0abc123");
    expect(await statuses()).toEqual({
      job: "failed",
      splat: "failed",
      errorMessage: "The worker ran past its time limit and was stopped.",
    });
  });

  it("leaves an instance inside the longer ceiling it was launched with", async () => {
    const job = await seed("training_running", 30);
    describeWorkerMock.mockResolvedValueOnce({
      state: "running",
      launchTime: new Date(Date.now() - 60 * MINUTE),
      maxLifetimeMinutes: 90,
    });

    expect(await reconcileJob(job)).toBe(false);
    expect(terminateWorkerMock).not.toHaveBeenCalled();
  });

  it("gives an instance with no lifetime tag the longest ceiling the setting allows", async () => {
    const job = await seed("training_running", 30);
    describeWorkerMock.mockResolvedValueOnce({
      state: "running",
      launchTime: new Date(Date.now() - 200 * MINUTE),
      maxLifetimeMinutes: null,
    });

    expect(await reconcileJob(job)).toBe(false);
    expect(terminateWorkerMock).not.toHaveBeenCalled();
  });

  it("leaves a job awaiting training alone, since no instance runs then", async () => {
    const job = await seed("awaiting_training", 300);

    expect(await reconcileJob(job)).toBe(false);
    expect(describeWorkerMock).not.toHaveBeenCalled();
  });

  it("doesn't fail a reconstruct stage that finished and terminated its instance during the lookup", async () => {
    const job = await seed("reconstruction_running", 30);
    describeWorkerMock.mockImplementationOnce(async () => {
      await getDb().update(jobs).set({ status: "awaiting_training" }).where(eq(jobs.id, job.id));
      return { state: "shutting-down", launchTime: new Date(Date.now() - 20 * MINUTE), maxLifetimeMinutes: 30 };
    });

    expect(await reconcileJob(job)).toBe(false);
    expect(await statuses()).toMatchObject({ job: "awaiting_training", splat: "processing" });
  });

  it("doesn't fail a job whose instance was replaced during the lookup", async () => {
    const job = await seed("training_running", 30);
    describeWorkerMock.mockImplementationOnce(async () => {
      await getDb().update(jobs).set({ ec2InstanceId: "i-0def456" }).where(eq(jobs.id, job.id));
      return null;
    });

    expect(await reconcileJob(job)).toBe(false);
    expect((await statuses()).job).toBe("training_running");
  });

  it("doesn't overwrite a job that ended during the lookup", async () => {
    const job = await seed("training_running", 30);
    describeWorkerMock.mockImplementationOnce(async () => {
      await getDb().update(jobs).set({ status: "complete" }).where(eq(jobs.id, job.id));
      return null;
    });

    expect(await reconcileJob(job)).toBe(false);
    expect(await statuses()).toMatchObject({ job: "complete", splat: "processing" });
  });
});
