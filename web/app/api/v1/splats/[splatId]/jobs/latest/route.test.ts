import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "clerk-user-1" })),
  clerkClient: async () => ({ users: { getUser: async () => ({}) } }),
}));

const { reconcileJobMock } = vi.hoisted(() => ({ reconcileJobMock: vi.fn(async (_job: unknown) => false) }));
vi.mock("@/lib/server/reconcileJob", () => ({ reconcileJob: reconcileJobMock }));

import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { jobs, splats, users } from "@/lib/server/db/schema";
import { JobStatus } from "@/lib/statuses";
import { GET } from "./route";

function ctx(splatId: string) {
  return { params: Promise.resolve({ splatId }) } as never;
}

function latestRequest() {
  return new NextRequest("http://localhost/api/v1/splats/jobs/latest");
}

// Requires a real Postgres (TEST_DATABASE_URL). reconcileJob is mocked so this never touches real AWS.
describe("GET /api/v1/splats/[splatId]/jobs/latest", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await getDb().delete(jobs);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function seed(clerkUserId = "clerk-user-1") {
    const user = await getOrCreateUser(clerkUserId);
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "obj" }).returning();
    await getDb().insert(jobs).values({
      splatId: splat.id,
      status: JobStatus.reconstruction_running,
      callbackToken: "t",
      ec2InstanceId: "i-0abc123",
    });
    return splat;
  }

  it("404s for someone else's splat, without reconciling its job", async () => {
    const splat = await seed("clerk-user-2");

    const res = await GET(latestRequest(), ctx(splat.id));

    expect(res.status).toBe(404);
    expect(reconcileJobMock).not.toHaveBeenCalled();
  });

  it("404s for a splat with no job yet", async () => {
    const user = await getOrCreateUser("clerk-user-1");
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "obj" }).returning();

    const res = await GET(latestRequest(), ctx(splat.id));

    expect(res.status).toBe(404);
  });

  it("returns the job as reconciled when reconciling failed it", async () => {
    const splat = await seed();
    reconcileJobMock.mockImplementationOnce(async () => {
      await getDb().update(jobs).set({ status: JobStatus.failed }).where(eq(jobs.splatId, splat.id));
      return true;
    });

    const res = await GET(latestRequest(), ctx(splat.id));

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("failed");
  });

  it("still returns the job when the instance lookup fails", async () => {
    const splat = await seed();
    reconcileJobMock.mockRejectedValueOnce(Object.assign(new Error("slow down"), { name: "RequestLimitExceeded" }));
    vi.spyOn(console, "error").mockImplementationOnce(() => {});

    const res = await GET(latestRequest(), ctx(splat.id));

    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("reconstruction_running");
  });
});
