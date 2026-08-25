import { and, desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/lib/server/db";
import { jobs, splats, users } from "@/lib/server/db/schema";
import { jobReadColumns } from "@/lib/server/selects";
import { PATCH } from "./route";

/**
 * Requires a real Postgres (TEST_DATABASE_URL). Covers three invariants of this route: the enum values are snake_case
 * end to end, `updatedAt` moves via `.$onUpdate()`, and the job/splat pair updates inside one transaction.
 */
const hasPostgres = Boolean(process.env.TEST_DATABASE_URL);

function req(token: string, body: unknown): NextRequest {
  return {
    headers: new Headers({ Authorization: `Bearer ${token}` }),
    json: async () => body,
  } as unknown as NextRequest;
}

function ctx(jobId: string) {
  return { params: Promise.resolve({ jobId }) } as never;
}

describe.skipIf(!hasPostgres)("worker status callback", () => {
  beforeEach(async () => {
    await getDb().delete(jobs);
    await getDb().delete(splats);
    await getDb().delete(users);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function seed() {
    const [user] = await getDb().insert(users).values({ clerkUserId: "u1" }).returning();
    const [splat] = await getDb().insert(splats).values({ userId: user.id, name: "obj" }).returning();
    const [job] = await getDb().insert(jobs).values({ splatId: splat.id, callbackToken: "tok" }).returning();
    return { splat, job };
  }

  it("writes the worker's status value straight through, and advances updatedAt", async () => {
    const { job } = await seed();
    expect(job.status).toBe("queued");

    const res = await PATCH(req("tok", { status: "colmap_running" }), ctx(job.id));
    expect(res.status).toBe(204);

    const [updated] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(updated.status).toBe("colmap_running");
    expect(updated.colmapStartedAt).not.toBeNull();
    // updatedAt only moves via .$onUpdate(); nothing in the database does it.
    expect(updated.updatedAt.getTime()).toBeGreaterThan(job.updatedAt.getTime());
  });

  it("does not overwrite a stage timestamp when a callback is duplicated", async () => {
    const { job } = await seed();
    await PATCH(req("tok", { status: "colmap_running" }), ctx(job.id));
    const [first] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));

    await PATCH(req("tok", { status: "colmap_running" }), ctx(job.id));
    const [second] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));

    expect(second.colmapStartedAt?.getTime()).toBe(first.colmapStartedAt?.getTime());
  });

  it("moves the job and its splat together on completion", async () => {
    const { splat, job } = await seed();

    const res = await PATCH(
      req("tok", { status: "complete", result_s3_key: "r.ply", thumbnail_s3_key: "t.jpg" }),
      ctx(job.id),
    );
    expect(res.status).toBe(204);

    const [updatedJob] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    const [updatedSplat] = await getDb().select().from(splats).where(eq(splats.id, splat.id));
    expect(updatedJob.status).toBe("complete");
    expect(updatedJob.resultS3Key).toBe("r.ply");
    expect(updatedSplat.status).toBe("complete");
    expect(updatedSplat.thumbnailS3Key).toBe("t.jpg");
  });

  it("rejects a status value that is not a database enum label", async () => {
    // Only the snake_case enum label is a valid wire value; PascalCase is rejected.
    const { job } = await seed();
    const res = await PATCH(req("tok", { status: "ColmapRunning" }), ctx(job.id));
    expect(res.status).toBe(422);
  });

  it("never selects the callback token or instance id into a job response", () => {
    // The omission is enforced by the SQL, not by deleting keys afterwards.
    const { sql } = getDb()
      .select(jobReadColumns)
      .from(jobs)
      .innerJoin(splats, eq(jobs.splatId, splats.id))
      .where(and(eq(jobs.splatId, "x"), eq(splats.userId, "y")))
      .orderBy(desc(jobs.createdAt))
      .limit(1)
      .toSQL();

    expect(sql).not.toContain("callback_token");
    expect(sql).not.toContain("ec2_instance_id");
  });
});
