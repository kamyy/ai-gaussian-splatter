import { describe, expect, it } from "vitest";

import { formatClock, formatDuration, stageTimings } from "../stageTimings";
import { JobStatus } from "../statuses";
import type { Job } from "../types";

const T0 = Date.parse("2026-01-01T10:00:00Z");

function at(seconds: number): string {
  return new Date(T0 + seconds * 1000).toISOString();
}

const baseJob: Job = {
  id: "job-1",
  splatId: "splat-1",
  status: JobStatus.queued,
  errorMessage: null,
  resultS3Key: null,
  thumbnailS3Key: null,
  pointCloudS3Key: null,
  colmapBootedAt: null,
  colmapStartedAt: null,
  colmapFinishedAt: null,
  trainingLaunchedAt: null,
  trainingBootedAt: null,
  trainingStartedAt: null,
  trainingProgress: null,
  createdAt: at(0),
  updatedAt: at(0),
};

// A job that placed its cameras from 0s to 472s (220s of it start-up), waited 720s for the visitor, then built.
const reconstructed = {
  ...baseJob,
  pointCloudS3Key: "splats/splat-1/points.ply",
  colmapStartedAt: at(220),
  colmapFinishedAt: at(472),
};

describe("stageTimings", () => {
  it("splits placing the cameras into start-up and work once it has finished", () => {
    const timings = stageTimings({ ...reconstructed, status: JobStatus.awaiting_training }, T0 + 10_000_000);

    expect(timings.cameras).toEqual({
      totalMs: 472_000,
      running: false,
      startupMs: 220_000,
      bootMs: null,
      pullMs: null,
      workMs: 252_000,
    });
    expect(timings.checkMs).toBeNull();
    expect(timings.build).toBeNull();
  });

  it("splits start-up into boot and image pull when the worker reported its boot time", () => {
    const timings = stageTimings(
      { ...reconstructed, status: JobStatus.awaiting_training, colmapBootedAt: at(70) },
      T0 + 10_000_000,
    );

    expect(timings.cameras).toEqual({
      totalMs: 472_000,
      running: false,
      startupMs: 220_000,
      bootMs: 70_000,
      pullMs: 150_000,
      workMs: 252_000,
    });
  });

  it("counts a running stage up to now, with no split before the worker's first callback", () => {
    const starting = stageTimings({ ...baseJob, status: JobStatus.launching }, T0 + 60_000);
    expect(starting.cameras).toEqual({
      totalMs: 60_000,
      running: true,
      startupMs: null,
      bootMs: null,
      pullMs: null,
      workMs: null,
    });

    const working = stageTimings(
      { ...baseJob, status: JobStatus.reconstruction_running, colmapStartedAt: at(220) },
      T0 + 300_000,
    );
    expect(working.cameras).toEqual({
      totalMs: 300_000,
      running: true,
      startupMs: 220_000,
      bootMs: null,
      pullMs: null,
      workMs: 80_000,
    });
  });

  it("times the visitor's check and a running build from the train stage's launch", () => {
    const timings = stageTimings(
      {
        ...reconstructed,
        status: JobStatus.training_running,
        trainingLaunchedAt: at(1192),
        trainingStartedAt: at(1377),
      },
      T0 + 1463_000,
    );

    expect(timings.checkMs).toBe(720_000);
    expect(timings.build).toEqual({
      totalMs: 271_000,
      running: true,
      startupMs: 185_000,
      bootMs: null,
      pullMs: null,
      workMs: 86_000,
    });
  });

  it("ends a complete build at the job's last update", () => {
    const timings = stageTimings(
      {
        ...reconstructed,
        status: JobStatus.complete,
        trainingLaunchedAt: at(1192),
        trainingStartedAt: at(1377),
        updatedAt: at(1807),
      },
      T0 + 99_000_000,
    );

    expect(timings.build).toEqual({
      totalMs: 615_000,
      running: false,
      startupMs: 185_000,
      bootMs: null,
      pullMs: null,
      workMs: 430_000,
    });
  });

  it("gives a stage that failed partway no timing", () => {
    const timings = stageTimings(
      { ...reconstructed, status: JobStatus.failed, trainingLaunchedAt: at(1192), trainingStartedAt: at(1377) },
      T0 + 99_000_000,
    );

    expect(timings.cameras?.totalMs).toBe(472_000);
    expect(timings.build).toBeNull();
  });

  it("leaves out the build for a job trained before its launch time was recorded", () => {
    const timings = stageTimings(
      { ...reconstructed, status: JobStatus.complete, trainingStartedAt: at(1377), updatedAt: at(1807) },
      T0 + 99_000_000,
    );

    expect(timings.checkMs).toBeNull();
    expect(timings.build).toBeNull();
  });

  it("never reads negative when the client's clock is behind the server's", () => {
    const timings = stageTimings({ ...baseJob, status: JobStatus.launching }, T0 - 5_000);

    expect(timings.cameras?.totalMs).toBe(0);
  });
});

describe("formatDuration", () => {
  it.each([
    [22_000, "22s"],
    [59_400, "59s"],
    [60_000, "1m 00s"],
    [472_000, "7m 52s"],
    [3_780_000, "1h 03m"],
  ])("formats %ims as %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("formatClock", () => {
  it.each([
    [5_000, "0:05"],
    [271_000, "4:31"],
    [3_729_000, "1:02:09"],
  ])("formats %ims as %s", (ms, text) => {
    expect(formatClock(ms)).toBe(text);
  });
});
