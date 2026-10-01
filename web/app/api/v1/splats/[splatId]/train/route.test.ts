import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "clerk-user-1" })),
  clerkClient: async () => ({ users: { getUser: async () => ({}) } }),
}));

const { launchJobMock, terminateWorkerMock } = vi.hoisted(() => ({
  launchJobMock: vi.fn(async (_params: { jobId: string }) => "i-0abc123"),
  terminateWorkerMock: vi.fn(async () => {}),
}));
vi.mock("@/lib/server/ec2Launcher", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/server/ec2Launcher")>();
  return { ...actual, launchJob: launchJobMock, terminateWorker: terminateWorkerMock };
});

import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { globalJobCounters, jobs, splats, users } from "@/lib/server/db/schema";
import type { JobStatus } from "@/lib/statuses";
import { POST } from "./route";

function trainRequest(body: unknown = {}) {
  return new Request("http://localhost/api/v1/splats/x/train", {
    method: "POST",
    body: JSON.stringify(body),
  }) as never;
}

function ctx(splatId: string) {
  return { params: Promise.resolve({ splatId }) } as never;
}

// Requires a real Postgres (TEST_DATABASE_URL). launchJob is mocked so this never touches real AWS. Only the atomic
// status flip and the daily-cap gate are under test here.
describe("POST /api/v1/splats/[splatId]/train", () => {
  beforeEach(async () => {
    launchJobMock.mockClear();
    terminateWorkerMock.mockClear();
    await getDb().delete(jobs);
    await getDb().delete(splats);
    await getDb().delete(users);
    await getDb().delete(globalJobCounters);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function seed(jobStatus: JobStatus = "awaiting_training", clerkUserId = "clerk-user-1") {
    const user = await getOrCreateUser(clerkUserId);
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "obj" }).returning();
    const [job] = await getDb()
      .insert(jobs)
      .values({ splatId: splat.id, callbackToken: "tok", status: jobStatus })
      .returning();
    return { user, splat, job };
  }

  it("404s for a splat the caller doesn't own, leaving its job untouched", async () => {
    const { splat, job } = await seed("awaiting_training", "clerk-user-2");

    const res = await POST(trainRequest(), ctx(splat.id));
    expect(res.status).toBe(404);
    expect(launchJobMock).not.toHaveBeenCalled();
    const [unchanged] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(unchanged.status).toBe("awaiting_training");
  });

  it("refuses while processing is paused, leaving the job awaiting training and the daily cap uncharged", async () => {
    const { splat, job } = await seed();
    process.env.PROCESSING_ENABLED = "false";
    try {
      const res = await POST(trainRequest(), ctx(splat.id));

      expect(res.status).toBe(503);
      expect((await res.json()).detail).toMatch(/^Processing is paused for the whole site/);
    } finally {
      delete process.env.PROCESSING_ENABLED;
    }

    expect(launchJobMock).not.toHaveBeenCalled();
    const [unchanged] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(unchanged.status).toBe("awaiting_training");
    expect(await getDb().select().from(globalJobCounters)).toEqual([]);
  });

  it("launches the train stage, reusing the job's own id and callback token", async () => {
    const { splat, job } = await seed();

    const res = await POST(trainRequest(), ctx(splat.id));
    expect(res.status).toBe(200);
    expect(launchJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id, splatId: splat.id, callbackToken: "tok", stage: "train" }),
    );

    const [updated] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(updated.status).toBe("launching");
    expect(updated.ec2InstanceId).toBe("i-0abc123");
  });

  it("records when the train stage's instance was launched", async () => {
    const { splat, job } = await seed();
    const before = Date.now();

    await POST(trainRequest(), ctx(splat.id));

    const [updated] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(updated.trainingLaunchedAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(updated.trainingLaunchedAt?.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("clears the launch time when the instance fails to launch", async () => {
    const { splat, job } = await seed();
    launchJobMock.mockRejectedValueOnce(new Error("InsufficientInstanceCapacity"));

    await expect(POST(trainRequest(), ctx(splat.id))).rejects.toThrow("InsufficientInstanceCapacity");

    const [updated] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(updated.status).toBe("awaiting_training");
    expect(updated.trainingLaunchedAt).toBeNull();
  });

  it("clears the launch time when the daily cap rejects the build", async () => {
    const { splat, job } = await seed();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    await getDb().insert(globalJobCounters).values({ day: today, jobsStarted: 1_000_000 });

    expect((await POST(trainRequest(), ctx(splat.id))).status).toBe(503);

    const [updated] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(updated.status).toBe("awaiting_training");
    expect(updated.trainingLaunchedAt).toBeNull();
    expect(launchJobMock).not.toHaveBeenCalled();
  });

  it("keeps a cancel that lands while the launch is failing", async () => {
    const { splat, job } = await seed();
    launchJobMock.mockImplementationOnce(async ({ jobId }) => {
      await getDb().update(jobs).set({ status: "cancelled" }).where(eq(jobs.id, jobId));
      throw new Error("InsufficientInstanceCapacity");
    });

    await expect(POST(trainRequest(), ctx(splat.id))).rejects.toThrow("InsufficientInstanceCapacity");

    const [row] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(row.status).toBe("cancelled");
  });

  it("terminates the worker it just launched when the job was cancelled during the launch", async () => {
    const { splat, job } = await seed();
    launchJobMock.mockImplementationOnce(async ({ jobId }) => {
      await getDb().update(jobs).set({ status: "cancelled" }).where(eq(jobs.id, jobId));
      return "i-0late";
    });

    const res = await POST(trainRequest(), ctx(splat.id));
    expect(res.status).toBe(409);
    expect(terminateWorkerMock).toHaveBeenCalledWith("i-0late");
    const [row] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(row.status).toBe("cancelled");
    expect(row.ec2InstanceId).toBeNull();
  });

  it("passes a crop box through to the train stage's worker", async () => {
    const { splat } = await seed();
    const cropBox = { center: [1, 2, 3], size: [4, 5, 6], quaternion: [0, 0, 0, 1] };

    const res = await POST(trainRequest({ cropBox }), ctx(splat.id));
    expect(res.status).toBe(200);
    expect(launchJobMock).toHaveBeenCalledWith(expect.objectContaining({ cropBox }));
  });

  it.each([
    ["a missing body", undefined],
    ["a non-positive size", { cropBox: { center: [0, 0, 0], size: [1, 0, 1], quaternion: [0, 0, 0, 1] } }],
    ["a zero quaternion", { cropBox: { center: [0, 0, 0], size: [1, 1, 1], quaternion: [0, 0, 0, 0] } }],
    [
      "a string where a number goes",
      { cropBox: { center: ["0';reboot;'", 0, 0], size: [1, 1, 1], quaternion: [0, 0, 0, 1] } },
    ],
  ])("422s on %s without moving the job or charging the cap", async (_label, body) => {
    const { splat, job } = await seed();
    const request =
      body === undefined
        ? (new Request("http://localhost/api/v1/splats/x/train", { method: "POST" }) as never)
        : trainRequest(body);

    const res = await POST(request, ctx(splat.id));
    expect(res.status).toBe(422);
    expect(launchJobMock).not.toHaveBeenCalled();

    const [unchanged] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(unchanged.status).toBe("awaiting_training");
    expect(await getDb().select().from(globalJobCounters)).toEqual([]);
  });

  it("409s when the latest job for the splat isn't awaiting_training", async () => {
    const { splat } = await seed("training_running");

    const res = await POST(trainRequest(), ctx(splat.id));
    expect(res.status).toBe(409);
    expect(launchJobMock).not.toHaveBeenCalled();
  });

  it("409s on a concurrent double-click — the atomic status flip lets only one launch through", async () => {
    const { splat } = await seed();

    const [first, second] = await Promise.all([
      POST(trainRequest(), ctx(splat.id)),
      POST(trainRequest(), ctx(splat.id)),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(launchJobMock).toHaveBeenCalledTimes(1);
  });

  it("charges the daily cap only for the POST that wins the flip", async () => {
    // The cap is the site-wide GPU budget. A losing double-click that still consumed a unit would let one user lock
    // every other user out for the day without launching anything.
    const { splat } = await seed();

    expect((await POST(trainRequest(), ctx(splat.id))).status).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await POST(trainRequest(), ctx(splat.id))).status).toBe(409);
    }

    const [counter] = await getDb().select().from(globalJobCounters);
    expect(counter.jobsStarted).toBe(1);
  });
});
