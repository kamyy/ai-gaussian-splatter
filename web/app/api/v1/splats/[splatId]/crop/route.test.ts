import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "clerk-user-1" })),
  clerkClient: async () => ({ users: { getUser: async () => ({}) } }),
}));

const { cropSplatFilesMock, deleteObjectsMock } = vi.hoisted(() => ({
  cropSplatFilesMock: vi.fn(async (_source: unknown, _target: unknown, _box: unknown) => {}),
  deleteObjectsMock: vi.fn(async (_keys: string[]) => {}),
}));
vi.mock("@/lib/server/cropSplat", () => ({ cropSplatFiles: cropSplatFilesMock }));
vi.mock("@/lib/server/s3", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/server/s3")>();
  return { ...actual, deleteSplatsBucketObjects: deleteObjectsMock };
});

import { getOrCreateUser } from "@/lib/server/auth";
import { closeDb, getDb } from "@/lib/server/db";
import { jobs, rateLimitCounters, splats, users } from "@/lib/server/db/schema";
import { HttpError } from "@/lib/server/httpError";
import { userCropRateLimitScope } from "@/lib/server/rateLimit";
import type { JobStatus } from "@/lib/statuses";
import { DELETE, POST } from "./route";

const BOX = { center: [1, 2, 3], size: [4, 5, 6], quaternion: [0, 0, 0, 1] };

function cropRequest(body: unknown) {
  return new Request("http://localhost/api/v1/splats/x/crop", { method: "POST", body: JSON.stringify(body) }) as never;
}

function ctx(splatId: string) {
  return { params: Promise.resolve({ splatId }) } as never;
}

// Requires a real Postgres (TEST_DATABASE_URL). The cropper and S3 deletes are mocked, so nothing reaches AWS.
describe("/api/v1/splats/[splatId]/crop", () => {
  beforeEach(async () => {
    cropSplatFilesMock.mockReset();
    deleteObjectsMock.mockClear();
    await getDb().delete(jobs);
    await getDb().delete(splats);
    await getDb().delete(users);
    await getDb().delete(rateLimitCounters);
  });

  afterAll(async () => {
    await closeDb();
  });

  async function seed({ jobStatus = "complete" as JobStatus, clerkUserId = "clerk-user-1", cropped = false } = {}) {
    const user = await getOrCreateUser(clerkUserId);
    const [splat] = await getDb()
      .insert(splats)
      .values({ userId: user.id, name: "obj", status: "complete", thumbnailS3Key: "splats/x/original-thumbnail.png" })
      .returning();
    const [job] = await getDb()
      .insert(jobs)
      .values({
        splatId: splat.id,
        callbackToken: "tok",
        status: jobStatus,
        resultPlyS3Key: `splats/${splat.id}/result.ply`,
        resultSpzS3Key: `splats/${splat.id}/result.spz`,
        thumbnailS3Key: `splats/${splat.id}/thumbnail.png`,
        ...(cropped
          ? {
              cropBox: { center: [0, 0, 0], size: [1, 1, 1], quaternion: [0, 0, 0, 1] },
              croppedResultPlyS3Key: `splats/${splat.id}/crops/old/result.ply`,
              croppedResultSpzS3Key: `splats/${splat.id}/crops/old/result.spz`,
            }
          : {}),
      })
      .returning();
    return { user, splat, job };
  }

  async function reload(splatId: string, jobId: string) {
    const [job] = await getDb().select().from(jobs).where(eq(jobs.id, jobId));
    const [splat] = await getDb().select().from(splats).where(eq(splats.id, splatId));
    return { job, splat };
  }

  describe("POST", () => {
    it("crops the originals into new keys and points the job at them", async () => {
      const { splat, job } = await seed();

      const res = await POST(cropRequest({ box: BOX }), ctx(splat.id));
      expect(res.status).toBe(200);
      expect((await res.json()).cropBox).toEqual(BOX);

      const [source, target, box] = cropSplatFilesMock.mock.calls[0];
      expect(source).toEqual({ ply: job.resultPlyS3Key, spz: job.resultSpzS3Key });
      expect(box).toEqual(BOX);

      const after = await reload(splat.id, job.id);
      expect(target).toEqual({
        ply: after.job.croppedResultPlyS3Key,
        spz: after.job.croppedResultSpzS3Key,
      });
      expect(after.job.croppedResultPlyS3Key).toMatch(new RegExp(`^splats/${splat.id}/crops/[0-9a-f-]+/result\\.ply$`));
      expect(after.job.resultPlyS3Key).toBe(job.resultPlyS3Key);
      expect(after.job.updatedAt.getTime()).toBeGreaterThan(job.updatedAt.getTime());
      expect(after.splat.thumbnailS3Key).toBe("splats/x/original-thumbnail.png");
    });

    it("replaces an earlier crop, starting again from the originals, and deletes the earlier crop's objects", async () => {
      const { splat, job } = await seed({ cropped: true });

      expect((await POST(cropRequest({ box: BOX }), ctx(splat.id))).status).toBe(200);

      expect(cropSplatFilesMock.mock.calls[0][0]).toEqual({ ply: job.resultPlyS3Key, spz: job.resultSpzS3Key });
      expect(deleteObjectsMock).toHaveBeenCalledWith([
        `splats/${splat.id}/crops/old/result.ply`,
        `splats/${splat.id}/crops/old/result.spz`,
      ]);
      expect((await reload(splat.id, job.id)).job.croppedResultPlyS3Key).not.toContain("/old/");
    });

    it("leaves the job uncropped when the box holds none of the splat", async () => {
      const { splat, job } = await seed();
      cropSplatFilesMock.mockRejectedValueOnce(new HttpError(422, "The crop box doesn't contain any of the splat"));

      const res = await POST(cropRequest({ box: BOX }), ctx(splat.id));
      expect(res.status).toBe(422);
      const after = await reload(splat.id, job.id);
      expect(after.job.cropBox).toBeNull();
      expect(after.job.updatedAt).toEqual(job.updatedAt);
      expect(await getDb().select().from(rateLimitCounters)).toEqual([]);
    });

    it("counts a crop only once it commits", async () => {
      const { splat, user } = await seed();

      expect((await POST(cropRequest({ box: BOX }), ctx(splat.id))).status).toBe(200);

      const [counter] = await getDb().select().from(rateLimitCounters);
      expect(counter).toMatchObject({ scope: userCropRateLimitScope(user.id), count: 1 });
    });

    it("429s once this hour's crops are used, without starting another", async () => {
      const { splat, user } = await seed();
      const hour = new Date();
      hour.setUTCMinutes(0, 0, 0);
      await getDb()
        .insert(rateLimitCounters)
        .values({ scope: userCropRateLimitScope(user.id), windowStart: hour, count: 30 });

      expect((await POST(cropRequest({ box: BOX }), ctx(splat.id))).status).toBe(429);
      expect(cropSplatFilesMock).not.toHaveBeenCalled();
      expect((await reload(splat.id, (await getDb().select().from(jobs))[0].id)).job.cropStartedAt).toBeNull();
    });

    it("refuses a second crop while one is already running", async () => {
      const { splat } = await seed();
      const { splat: other } = await seed();
      let release: () => void = () => {};
      const started = new Promise<void>(resolve => {
        cropSplatFilesMock.mockImplementationOnce(
          () =>
            new Promise(done => {
              release = () => done();
              resolve();
            }),
        );
      });

      const first = POST(cropRequest({ box: BOX }), ctx(splat.id));
      await started;

      const second = await POST(cropRequest({ box: BOX }), ctx(other.id));
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({ detail: "A crop is already running. Wait for it to finish." });

      release();
      expect((await first).status).toBe(200);
      expect(cropSplatFilesMock).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["an existing crop", true],
      ["the first crop", false],
    ])("drops a crop whose undo landed while the files were being written, over %s", async (_label, cropped) => {
      const { splat, job } = await seed({ cropped });
      let release: () => void = () => {};
      const started = new Promise<void>(resolve => {
        cropSplatFilesMock.mockImplementationOnce(
          () =>
            new Promise(done => {
              release = () => done();
              resolve();
            }),
        );
      });

      const cropping = POST(cropRequest({ box: BOX }), ctx(splat.id));
      await started;
      expect((await DELETE({} as never, ctx(splat.id))).status).toBe(200);

      release();
      expect((await cropping).status).toBe(409);
      expect((await reload(splat.id, job.id)).job.cropBox).toBeNull();
      expect((await reload(splat.id, job.id)).job.croppedResultPlyS3Key).toBeNull();
    });

    it("starts a crop when an earlier claim was abandoned", async () => {
      const { splat, job } = await seed();
      await getDb()
        .update(jobs)
        .set({ cropStartedAt: new Date("2000-01-01T00:00:00Z") })
        .where(eq(jobs.id, job.id));

      expect((await POST(cropRequest({ box: BOX }), ctx(splat.id))).status).toBe(200);
      expect((await reload(splat.id, job.id)).job.cropStartedAt).toBeNull();
    });

    it("404s for a splat the caller doesn't own", async () => {
      const { splat } = await seed({ clerkUserId: "clerk-user-2" });

      expect((await POST(cropRequest({ box: BOX }), ctx(splat.id))).status).toBe(404);
      expect(cropSplatFilesMock).not.toHaveBeenCalled();
    });

    it("404s before the splat has finished", async () => {
      const { splat } = await seed({ jobStatus: "training_running" });

      expect((await POST(cropRequest({ box: BOX }), ctx(splat.id))).status).toBe(404);
    });

    it.each([
      ["a missing box", {}],
      ["a non-positive size", { box: { ...BOX, size: [1, 0, 1] } }],
      ["a zero quaternion", { box: { ...BOX, quaternion: [0, 0, 0, 0] } }],
      ["a string where a number goes", { box: { ...BOX, center: ["0", 0, 0] } }],
    ])("422s on %s without cropping", async (_label, body) => {
      const { splat } = await seed();

      expect((await POST(cropRequest(body), ctx(splat.id))).status).toBe(422);
      expect(cropSplatFilesMock).not.toHaveBeenCalled();
    });

    it("deletes its own objects and 409s when the job was replaced while cropping", async () => {
      const { splat, job } = await seed();
      cropSplatFilesMock.mockImplementationOnce(async () => {
        await getDb().update(jobs).set({ status: "failed" }).where(eq(jobs.id, job.id));
      });

      expect((await POST(cropRequest({ box: BOX }), ctx(splat.id))).status).toBe(409);
      const [target] = cropSplatFilesMock.mock.calls[0].slice(1) as [{ ply: string; spz: string }];
      expect(deleteObjectsMock).toHaveBeenCalledWith([target.ply, target.spz]);
    });
  });

  describe("DELETE", () => {
    it("points everything back at the originals and deletes the crop's objects", async () => {
      const { splat, job } = await seed({ cropped: true });

      const res = await DELETE({} as never, ctx(splat.id));
      expect(res.status).toBe(200);
      expect((await res.json()).cropBox).toBeNull();

      const after = await reload(splat.id, job.id);
      expect(after.job.croppedResultPlyS3Key).toBeNull();
      expect(after.job.croppedResultSpzS3Key).toBeNull();
      expect(after.splat.thumbnailS3Key).toBe("splats/x/original-thumbnail.png");
      expect(deleteObjectsMock).toHaveBeenCalledWith([
        `splats/${splat.id}/crops/old/result.ply`,
        `splats/${splat.id}/crops/old/result.spz`,
      ]);
    });

    it("succeeds on a splat that isn't cropped", async () => {
      const { splat } = await seed();

      expect((await DELETE({} as never, ctx(splat.id))).status).toBe(200);
      expect(deleteObjectsMock).toHaveBeenCalledWith([]);
    });

    it("404s for a splat the caller doesn't own", async () => {
      const { splat, job } = await seed({ clerkUserId: "clerk-user-2", cropped: true });

      expect((await DELETE({} as never, ctx(splat.id))).status).toBe(404);
      expect((await reload(splat.id, job.id)).job.croppedResultPlyS3Key).not.toBeNull();
    });
  });
});
