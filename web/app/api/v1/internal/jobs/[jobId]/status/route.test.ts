import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb } from "@/lib/server/db";
import { jobs, splats, users } from "@/lib/server/db/schema";
import { PATCH } from "./route";

function req(token: string, body: unknown): NextRequest {
  return {
    headers: new Headers({ Authorization: `Bearer ${token}` }),
    json: async () => body,
  } as unknown as NextRequest;
}

const EARLIER = new Date("2026-01-01T00:00:00Z");

function ctx(jobId: string) {
  return { params: Promise.resolve({ jobId }) } as never;
}

// Requires a real Postgres (TEST_DATABASE_URL). Covers three invariants of this route: the enum values are snake_case
// end to end, `updatedAt` moves via `.$onUpdate()`, and the job/splat pair updates inside one transaction.
describe("worker status callback", () => {
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

    const res = await PATCH(req("tok", { status: "reconstruction_running" }), ctx(job.id));
    expect(res.status).toBe(204);

    const [updated] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(updated.status).toBe("reconstruction_running");
    expect(updated.colmapStartedAt).not.toBeNull();

    // updatedAt only moves via .$onUpdate(); nothing in the database does it.
    expect(updated.updatedAt.getTime()).toBeGreaterThan(job.updatedAt.getTime());
  });

  it("ignores a callback for a job that has already ended", async () => {
    // web/app/api/v1/splats/[splatId]/process/route.ts cancels a job whose worker stopped reporting so the splat can
    // be processed again. Letting that worker wake up and write a non-terminal status back would give the splat a
    // second active job and trip uq_jobs_splat_id_active.
    const { job } = await seed();
    await getDb().update(jobs).set({ status: "cancelled" }).where(eq(jobs.id, job.id));

    const res = await PATCH(req("tok", { status: "reconstruction_running" }), ctx(job.id));
    expect(res.status).toBe(204);

    const [updated] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(updated.status).toBe("cancelled");
    expect(updated.colmapStartedAt).toBeNull();
  });

  it("does not overwrite a stage timestamp when a callback is duplicated", async () => {
    // A fixed time far in the past, so a rewrite shows up however quickly the two callbacks land.
    const { job } = await seed();
    await getDb()
      .update(jobs)
      .set({ status: "reconstruction_running", colmapStartedAt: EARLIER })
      .where(eq(jobs.id, job.id));

    await PATCH(req("tok", { status: "reconstruction_running" }), ctx(job.id));

    const [updated] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(updated.colmapStartedAt).toEqual(EARLIER);
  });

  it("records each stage's boot time from its first callback, and never overwrites it", async () => {
    const { job } = await seed();
    const booted = Date.parse("2026-01-01T00:01:00Z");

    await PATCH(req("tok", { status: "reconstruction_running", booted_at: booted }), ctx(job.id));
    await PATCH(req("tok", { status: "reconstruction_running", booted_at: booted + 5000 }), ctx(job.id));
    await PATCH(req("tok", { status: "training_running", booted_at: booted + 60_000 }), ctx(job.id));

    const [updated] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(updated.colmapBootedAt).toEqual(new Date(booted));
    expect(updated.trainingBootedAt).toEqual(new Date(booted + 60_000));
  });

  it("leaves the boot time null for a local run that reports none", async () => {
    const { job } = await seed();
    await PATCH(req("tok", { status: "reconstruction_running" }), ctx(job.id));

    const [updated] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(updated.colmapBootedAt).toBeNull();
  });

  it("stamps colmapFinishedAt on awaiting_training, not on the later training_running callback", async () => {
    // awaiting_training can sit for hours while the user decides whether to train. Stamping colmapFinishedAt on
    // training_running instead would fold that think-time into COLMAP's own wall clock.
    const { job } = await seed();
    await PATCH(req("tok", { status: "reconstruction_running" }), ctx(job.id));

    await PATCH(req("tok", { status: "awaiting_training", point_cloud_s3_key: "p.ply" }), ctx(job.id));
    const [afterAwaiting] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(afterAwaiting.colmapFinishedAt).not.toBeNull();
    expect(afterAwaiting.trainingStartedAt).toBeNull();
    expect(afterAwaiting.pointCloudS3Key).toBe("p.ply");

    await PATCH(req("tok", { status: "training_running" }), ctx(job.id));
    const [afterTraining] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(afterTraining.colmapFinishedAt?.getTime()).toBe(afterAwaiting.colmapFinishedAt?.getTime());
    expect(afterTraining.trainingStartedAt).not.toBeNull();
  });

  it("records training progress, and rejects a value outside 0-100", async () => {
    const { job } = await seed();

    await PATCH(req("tok", { status: "training_running", training_progress: 35 }), ctx(job.id));
    const [updated] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(updated.trainingProgress).toBe(35);

    const res = await PATCH(req("tok", { status: "training_running", training_progress: 140 }), ctx(job.id));
    expect(res.status).toBe(422);
  });

  it("moves the job and its splat together on completion", async () => {
    const { splat, job } = await seed();

    const res = await PATCH(
      req("tok", { status: "complete", result_s3_key: "r.ply", result_spz_s3_key: "r.spz", thumbnail_s3_key: "t.jpg" }),
      ctx(job.id),
    );
    expect(res.status).toBe(204);

    const [updatedJob] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    const [updatedSplat] = await getDb().select().from(splats).where(eq(splats.id, splat.id));
    expect(updatedJob.status).toBe("complete");
    expect(updatedJob.resultS3Key).toBe("r.ply");
    expect(updatedJob.resultSpzS3Key).toBe("r.spz");
    expect(updatedSplat.status).toBe("complete");
    expect(updatedSplat.thumbnailS3Key).toBe("t.jpg");
  });

  it("fails the splat along with its job", async () => {
    const { splat, job } = await seed();

    await PATCH(req("tok", { status: "failed", error_message: "COLMAP crashed" }), ctx(job.id));

    const [updatedJob] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    const [updatedSplat] = await getDb().select().from(splats).where(eq(splats.id, splat.id));
    expect(updatedJob.status).toBe("failed");
    expect(updatedJob.errorMessage).toBe("COLMAP crashed");
    expect(updatedSplat.status).toBe("failed");
  });

  it("stamps colmapFinishedAt and trainingStartedAt on training_running when awaiting_training went missing", async () => {
    const { job } = await seed();

    await PATCH(req("tok", { status: "training_running" }), ctx(job.id));

    const [updated] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(updated.colmapFinishedAt).not.toBeNull();
    expect(updated.trainingStartedAt).not.toBeNull();
  });

  it("stamps trainingFinishedAt on uploading_result", async () => {
    const { job } = await seed();

    await PATCH(req("tok", { status: "uploading_result" }), ctx(job.id));

    const [updated] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(updated.trainingFinishedAt).not.toBeNull();
  });

  it("does not overwrite trainingFinishedAt when uploading_result is duplicated", async () => {
    const { job } = await seed();
    await getDb()
      .update(jobs)
      .set({ status: "uploading_result", trainingFinishedAt: EARLIER })
      .where(eq(jobs.id, job.id));

    await PATCH(req("tok", { status: "uploading_result" }), ctx(job.id));

    const [updated] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(updated.trainingFinishedAt).toEqual(EARLIER);
  });

  it.each([
    ["a PascalCase spelling", "ReconstructionRunning"],
    ["the enum's unused label", "colmap_running"],
  ])("rejects %s as a status", async (_label, status) => {
    const { job } = await seed();
    const res = await PATCH(req("tok", { status }), ctx(job.id));
    expect(res.status).toBe(422);
  });
});
