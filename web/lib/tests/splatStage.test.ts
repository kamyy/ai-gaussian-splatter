import { describe, expect, it } from "vitest";

import { currentStep, splatStage } from "../splatStage";
import { type Job, JobStatus } from "../types";

const baseJob: Job = {
  id: "job-1",
  splatId: "splat-1",
  status: JobStatus.queued,
  errorMessage: null,
  resultS3Key: null,
  thumbnailS3Key: null,
  pointCloudS3Key: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function job(overrides: Partial<Job>): Job {
  return { ...baseJob, ...overrides };
}

describe("splatStage", () => {
  it("is a dead end with no job and no photos, and ready to start with photos", () => {
    expect(splatStage(undefined, 0)).toEqual({ kind: "no_photos" });
    expect(splatStage(undefined, 12)).toEqual({ kind: "ready" });
  });

  it.each([
    [JobStatus.queued, "placing_cameras"],
    [JobStatus.launching, "placing_cameras"],
    [JobStatus.reconstruction_running, "placing_cameras"],
    [JobStatus.awaiting_training, "check"],
    [JobStatus.training_running, "building"],
    [JobStatus.uploading_result, "building"],
    [JobStatus.complete, "complete"],
  ])("maps a %s job to %s", (status, kind) => {
    expect(splatStage(job({ status }), 30).kind).toBe(kind);
  });

  it("places a failure at the step it happened in, going by whether a point cloud exists", () => {
    expect(splatStage(job({ status: JobStatus.failed, errorMessage: "too few" }), 30)).toEqual({
      kind: "failed",
      step: "cameras",
      message: "too few",
    });
    expect(splatStage(job({ status: JobStatus.failed, pointCloudS3Key: "pc.ply" }), 30)).toMatchObject({
      step: "build",
    });
    expect(splatStage(job({ status: JobStatus.cancelled, pointCloudS3Key: "pc.ply" }), 30)).toEqual({
      kind: "cancelled",
      step: "build",
    });
  });
});

describe("currentStep", () => {
  it("marks the step in progress, or none once complete", () => {
    expect(currentStep({ kind: "no_photos" })).toBe("upload");
    expect(currentStep({ kind: "ready" })).toBe("cameras");
    expect(currentStep({ kind: "check" })).toBe("check");
    expect(currentStep({ kind: "building" })).toBe("build");
    expect(currentStep({ kind: "failed", step: "build", message: null })).toBe("build");
    expect(currentStep({ kind: "complete" })).toBeNull();
  });
});
