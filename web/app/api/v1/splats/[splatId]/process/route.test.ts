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

import { MAX_PHOTOS_PER_SPLAT } from "@/lib/limits";
import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { globalJobCounters, jobs, photos, splats, users } from "@/lib/server/db/schema";
import { getRuntimeSettings } from "@/lib/server/runtimeSettings";
import { POST } from "./route";

function ctx(splatId: string) {
  return { params: Promise.resolve({ splatId }) } as never;
}

// Requires a real Postgres (TEST_DATABASE_URL). launchJob is mocked so this never touches real AWS. Covers the two
// safety properties this route relies on. First, uq_jobs_splat_id_active (web/lib/server/db/schema.ts) makes the
// double-trigger guard atomic. Second, a launch failure moves the job and splat to "failed" instead of leaving them at
// "queued" and "processing". Left there, the same constraint would block every future POST here for that splat.
describe("POST /api/v1/splats/[splatId]/process", () => {
  beforeEach(async () => {
    launchJobMock.mockClear();
    launchJobMock.mockResolvedValue("i-0abc123");
    terminateWorkerMock.mockClear();
    await getDb().delete(jobs);
    await getDb().delete(photos);
    await getDb().delete(splats);
    await getDb().delete(users);
    await getDb().delete(globalJobCounters);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function seed(photoCount?: number, clerkUserId = "clerk-user-1") {
    const length = photoCount ?? (await getRuntimeSettings()).minPhotosPerSplat;
    const user = await getOrCreateUser(clerkUserId);
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "obj" }).returning();
    await getDb()
      .insert(photos)
      .values(
        Array.from({ length }, (_, i) => ({
          splatId: splat.id,
          s3Key: `splats/${splat.id}/photos/${i}.jpg`,
          originalFilename: `${i}.jpg`,
          contentType: "image/jpeg",
          width: 4032,
          height: 3024,
          uploadStatus: "uploaded" as const,
        })),
      );
    return { user, splat };
  }

  it("refuses while processing is paused, before claiming a job or charging the daily cap", async () => {
    const { splat } = await seed();
    process.env.PROCESSING_ENABLED = "false";
    try {
      const res = await POST({} as never, ctx(splat.id));

      expect(res.status).toBe(503);
      expect((await res.json()).detail).toMatch(/^Processing is paused for the whole site/);
    } finally {
      delete process.env.PROCESSING_ENABLED;
    }

    expect(launchJobMock).not.toHaveBeenCalled();
    expect(await getDb().select().from(jobs)).toEqual([]);
    expect(await getDb().select().from(globalJobCounters)).toEqual([]);
  });

  it("launches a reconstruct-stage job", async () => {
    const { splat } = await seed();

    const res = await POST({} as never, ctx(splat.id));
    expect(res.status).toBe(201);
    expect(launchJobMock).toHaveBeenCalledWith(expect.objectContaining({ splatId: splat.id, stage: "reconstruct" }));
  });

  it("404s for a splat the caller doesn't own", async () => {
    const { splat } = await seed(undefined, "clerk-user-2");

    const res = await POST({} as never, ctx(splat.id));
    expect(res.status).toBe(404);
    expect(launchJobMock).not.toHaveBeenCalled();
    expect(await getDb().select().from(jobs)).toEqual([]);
  });

  it("refuses a splat with fewer than the minimum photos uploaded, before charging the daily cap", async () => {
    const { splat } = await seed((await getRuntimeSettings()).minPhotosPerSplat - 1);

    const res = await POST({} as never, ctx(splat.id));
    expect(res.status).toBe(400);
    expect(launchJobMock).not.toHaveBeenCalled();
    expect(await getDb().select().from(globalJobCounters)).toEqual([]);
  });

  it("deletes the job it claimed when the daily cap rejects, so the splat stays ready to start", async () => {
    const { splat } = await seed();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    await getDb().insert(globalJobCounters).values({ day: today, jobsStarted: 1_000_000 });

    const res = await POST({} as never, ctx(splat.id));
    expect(res.status).toBe(503);
    expect(launchJobMock).not.toHaveBeenCalled();
    expect(await getDb().select().from(jobs)).toEqual([]);
    const [unchanged] = await getDb().select().from(splats).where(eq(splats.id, splat.id));
    expect(unchanged.status).toBe("draft");
  });

  it("refuses a splat with more than MAX_PHOTOS_PER_SPLAT uploaded photos, before charging the daily cap", async () => {
    const { splat } = await seed(MAX_PHOTOS_PER_SPLAT + 1);

    const res = await POST({} as never, ctx(splat.id));
    expect(res.status).toBe(400);
    expect(launchJobMock).not.toHaveBeenCalled();
    expect(await getDb().select().from(globalJobCounters)).toEqual([]);
  });

  it("terminates the worker it just launched when the job was cancelled during the launch", async () => {
    const { splat } = await seed();
    launchJobMock.mockImplementationOnce(async ({ jobId }) => {
      await getDb().update(jobs).set({ status: "cancelled" }).where(eq(jobs.id, jobId));
      return "i-0late";
    });

    const res = await POST({} as never, ctx(splat.id));
    expect(res.status).toBe(409);
    expect(terminateWorkerMock).toHaveBeenCalledWith("i-0late");
    const [row] = await getDb().select().from(jobs).where(eq(jobs.splatId, splat.id));
    expect(row.status).toBe("cancelled");
  });

  it("keeps a cancel that lands while the launch is failing, without failing the splat", async () => {
    const { splat } = await seed();
    launchJobMock.mockImplementationOnce(async ({ jobId }) => {
      await getDb().update(jobs).set({ status: "cancelled" }).where(eq(jobs.id, jobId));
      throw new Error("RunInstances denied");
    });

    await expect(POST({} as never, ctx(splat.id))).rejects.toThrow("RunInstances denied");

    const [job] = await getDb().select().from(jobs).where(eq(jobs.splatId, splat.id));
    expect(job.status).toBe("cancelled");
    const [updatedSplat] = await getDb().select().from(splats).where(eq(splats.id, splat.id));
    expect(updatedSplat.status).not.toBe("failed");
  });

  it("409s on a concurrent double-click — the unique index lets only one job through", async () => {
    const { splat } = await seed();

    const [first, second] = await Promise.all([POST({} as never, ctx(splat.id)), POST({} as never, ctx(splat.id))]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(launchJobMock).toHaveBeenCalledTimes(1);

    const rows = await getDb().select().from(jobs).where(eq(jobs.splatId, splat.id));
    expect(rows).toHaveLength(1);
  });

  it("charges the daily cap only for a POST that actually claims a job", async () => {
    // The cap is the site-wide GPU budget. A rejected duplicate that still consumed a unit would let one user lock
    // every other user out for the day with max-jobs-per-day clicks on a button that launches nothing.
    const { splat } = await seed();

    const first = await POST({} as never, ctx(splat.id));
    expect(first.status).toBe(201);
    for (let i = 0; i < 5; i++) {
      const duplicate = await POST({} as never, ctx(splat.id));
      expect(duplicate.status).toBe(409);
    }

    const [counter] = await getDb().select().from(globalJobCounters);
    expect(counter.jobsStarted).toBe(1);
  });

  it("cancels a job whose worker stopped reporting, so the splat isn't blocked forever", async () => {
    // A dead worker's job that web/lib/server/reconcileJob.ts never failed stays active, and uq_jobs_splat_id_active
    // makes an active job block every later POST here. Without the sweep the splat would be stranded permanently.
    const { splat } = await seed();
    const first = await POST({} as never, ctx(splat.id));
    expect(first.status).toBe(201);

    const stale = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await getDb().update(jobs).set({ updatedAt: stale }).where(eq(jobs.splatId, splat.id));

    const retry = await POST({} as never, ctx(splat.id));
    expect(retry.status).toBe(201);

    const rows = await getDb().select().from(jobs).where(eq(jobs.splatId, splat.id));
    expect(rows.map(row => row.status).sort()).toEqual(["cancelled", "launching"]);
  });

  it("leaves a job that is still reporting alone", async () => {
    const { splat } = await seed();
    await POST({} as never, ctx(splat.id));

    const res = await POST({} as never, ctx(splat.id));
    expect(res.status).toBe(409);
    expect(launchJobMock).toHaveBeenCalledTimes(1);
  });

  it("marks the job and splat failed, not stuck, when the launch itself throws", async () => {
    const { splat } = await seed();
    launchJobMock.mockRejectedValueOnce(new Error("RunInstances denied"));

    // Not an HttpError, so withErrorHandling (web/lib/server/httpError.ts) rethrows it rather than converting it to a
    // response. The route's own catch runs first, for the DB cleanup asserted below.
    await expect(POST({} as never, ctx(splat.id))).rejects.toThrow("RunInstances denied");

    const [job] = await getDb().select().from(jobs).where(eq(jobs.splatId, splat.id));
    expect(job.status).toBe("failed");
    expect(job.errorMessage).toContain("RunInstances denied");
    const [updatedSplat] = await getDb().select().from(splats).where(eq(splats.id, splat.id));
    expect(updatedSplat.status).toBe("failed");

    // "failed" is an ended status, so uq_jobs_splat_id_active doesn't block trying again.
    const retry = await POST({} as never, ctx(splat.id));
    expect(retry.status).toBe(201);
  });
});
