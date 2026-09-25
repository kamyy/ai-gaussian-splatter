import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId: "clerk-user-1" })) }));

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
import { globalJobCounters, jobs, photos, splats, users } from "@/lib/server/db/schema";
import { getEnv } from "@/lib/server/env";
import { POST } from "./route";

function ctx(splatId: string) {
  return { params: Promise.resolve({ splatId }) } as never;
}

/**
 * Requires a real Postgres (TEST_DATABASE_URL). launchJob is mocked so this never touches real AWS. Covers the two
 * safety properties this route relies on: uq_jobs_splat_id_active (web/lib/server/db/schema.ts) makes the
 * double-trigger guard atomic, and a launch failure moves the job/splat to "failed" rather than stranding them at
 * "queued"/"processing" — which would otherwise permanently block every future POST here for that splat under the
 * same constraint.
 */
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

  async function seed() {
    const user = await getOrCreateUser("clerk-user-1");
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "obj" }).returning();
    const minPhotos = getEnv().MIN_PHOTOS_PER_SPLAT;
    await getDb()
      .insert(photos)
      .values(
        Array.from({ length: minPhotos }, (_, i) => ({
          splatId: splat.id,
          s3Key: `splats/${splat.id}/photos/${i}.jpg`,
          originalFilename: `${i}.jpg`,
          contentType: "image/jpeg",
          uploadStatus: "uploaded" as const,
        })),
      );
    return { user, splat };
  }

  it("launches a reconstruct-stage job", async () => {
    const { splat } = await seed();

    const res = await POST({} as never, ctx(splat.id));
    expect(res.status).toBe(201);
    expect(launchJobMock).toHaveBeenCalledWith(expect.objectContaining({ splatId: splat.id, stage: "reconstruct" }));
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
    // every other user out for the day with GLOBAL_MAX_JOBS_PER_DAY clicks on a button that launches nothing.
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
    // Nothing outside the worker moves a job on from "launching", and uq_jobs_splat_id_active makes an active job
    // block every later POST here. A dead worker would otherwise strand the splat permanently.
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
