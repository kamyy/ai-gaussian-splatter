import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "clerk-user-1" })),
  clerkClient: async () => ({ users: { getUser: async () => ({}) } }),
}));

import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { jobs, splats, users } from "@/lib/server/db/schema";
import type { JobStatus, SplatStatus } from "@/lib/statuses";
import { GET } from "./route";

function ctx(splatId: string) {
  return { params: Promise.resolve({ splatId }) } as never;
}

describe("GET /api/v1/splats/[splatId]/viewer-splat", () => {
  beforeEach(async () => {
    await getDb().delete(jobs);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function seed(
    splatStatus: SplatStatus,
    jobStatus: JobStatus,
    resultSpzS3Key: string | null,
    clerkUserId = "clerk-user-1",
  ) {
    const user = await getOrCreateUser(clerkUserId);
    const [splat] = await getDb()
      .insert(splats)
      .values({ userId: user.id, name: "obj", status: splatStatus })
      .returning();
    await getDb().insert(jobs).values({
      splatId: splat.id,
      callbackToken: "tok",
      status: jobStatus,
      resultS3Key: "splats/x/result.ply",
      resultSpzS3Key,
    });

    return splat;
  }

  it("returns the .spz, not the .ply the download route serves", async () => {
    const splat = await seed("complete", "complete", "splats/x/result.spz");

    const res = await GET({} as never, ctx(splat.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toContain("result.spz");
  });

  it("404s before the splat is complete", async () => {
    const splat = await seed("processing", "training_running", null);

    const res = await GET({} as never, ctx(splat.id));
    expect(res.status).toBe(404);
  });

  it("404s for a finished splat the caller doesn't own", async () => {
    const splat = await seed("complete", "complete", "splats/x/result.spz", "clerk-user-2");

    const res = await GET({} as never, ctx(splat.id));
    expect(res.status).toBe(404);
  });
});
