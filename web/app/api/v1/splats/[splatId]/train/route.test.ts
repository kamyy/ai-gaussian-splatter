import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn(async () => ({ userId: "clerk-user-1" })) }));

const { launchJobMock } = vi.hoisted(() => ({
  launchJobMock: vi.fn(async () => "i-0abc123"),
}));
vi.mock("@/lib/server/ec2Launcher", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/server/ec2Launcher")>();
  return { ...actual, launchJob: launchJobMock };
});

import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { globalJobCounters, jobs, splats, users } from "@/lib/server/db/schema";
import type { JobStatus } from "@/lib/types";
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

/**
 * Requires a real Postgres (TEST_DATABASE_URL). launchJob is mocked so this never touches real AWS. Only the atomic
 * status flip and the daily-cap gate are under test here.
 */
describe("POST /api/v1/splats/[splatId]/train", () => {
  beforeEach(async () => {
    launchJobMock.mockClear();
    await getDb().delete(jobs);
    await getDb().delete(splats);
    await getDb().delete(users);
    await getDb().delete(globalJobCounters);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function seed(jobStatus: JobStatus = "awaiting_training") {
    const user = await getOrCreateUser("clerk-user-1");
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "obj" }).returning();
    const [job] = await getDb()
      .insert(jobs)
      .values({ splatId: splat.id, callbackToken: "tok", status: jobStatus })
      .returning();
    return { user, splat, job };
  }

  it("404s for a splat the caller doesn't own", async () => {
    const res = await POST(trainRequest(), ctx("11111111-1111-4111-8111-111111111111"));
    expect(res.status).toBe(404);
    expect(launchJobMock).not.toHaveBeenCalled();
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
