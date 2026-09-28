import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type Job, JobStatus } from "@/lib/types";
import { PipelineStepper } from "./PipelineStepper";

const T0 = Date.parse("2026-01-01T10:00:00Z");

function at(seconds: number): string {
  return new Date(T0 + seconds * 1000).toISOString();
}

const reconstructed: Job = {
  id: "job-1",
  splatId: "splat-1",
  status: JobStatus.training_running,
  errorMessage: null,
  resultS3Key: null,
  thumbnailS3Key: null,
  pointCloudS3Key: "splats/splat-1/points.ply",
  colmapStartedAt: at(220),
  colmapFinishedAt: at(472),
  trainingLaunchedAt: at(1192),
  trainingStartedAt: at(1377),
  trainingProgress: 20,
  createdAt: at(0),
  updatedAt: at(1377),
};

describe("PipelineStepper", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows each finished step's time and counts the running one up", () => {
    vi.useFakeTimers({ now: T0 + 1463_000 });
    render(
      <PipelineStepper
        stage={{ kind: "building", progress: 20, startedAt: reconstructed.trainingStartedAt }}
        job={reconstructed}
        photoCount={38}
      />,
    );

    expect(screen.getByText("38 photos")).toBeTruthy();
    expect(screen.getByText("7m 52s")).toBeTruthy();
    expect(screen.getByText("GPU start-up 3m 40s · working 4m 12s")).toBeTruthy();
    expect(screen.getByText("you took 12m 00s")).toBeTruthy();
    expect(screen.getByText("4:31 so far")).toBeTruthy();
    expect(screen.getByText("GPU start-up 3m 05s · training 1m 26s")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("4:33 so far")).toBeTruthy();
  });

  it("sums the GPU time under the collapsed stepper once the splat is done", () => {
    render(
      <PipelineStepper
        stage={{ kind: "complete" }}
        job={{ ...reconstructed, status: JobStatus.complete, updatedAt: at(1807) }}
        photoCount={38}
      />,
    );

    expect(screen.getByText("Cameras 7m 52s · Build 10m 15s · 18m 07s of GPU time")).toBeTruthy();
  });
});
