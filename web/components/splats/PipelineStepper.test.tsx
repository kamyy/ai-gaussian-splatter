import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JobStatus } from "@/lib/statuses";
import type { Job } from "@/lib/types";
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
  resultPlyS3Key: null,
  thumbnailS3Key: null,
  pointCloudS3Key: "splats/splat-1/points.ply",
  colmapBootedAt: null,
  colmapStartedAt: at(220),
  colmapFinishedAt: at(472),
  trainingLaunchedAt: at(1192),
  trainingBootedAt: null,
  trainingStartedAt: at(1377),
  completedAt: null,
  trainingProgress: 20,
  cropBox: null,
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
    expect(screen.getByText("GPU start-up 3m 40s · reconstructing 4m 12s")).toBeTruthy();
    expect(screen.getByText("You took 12m 00s")).toBeTruthy();
    expect(screen.getByText("4:31 so far")).toBeTruthy();
    expect(screen.getByText("GPU start-up 3m 05s · training 1m 26s")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("4:33 so far")).toBeTruthy();
  });

  it("keeps the stepper vertical once the splat is done, with every step's time", () => {
    render(
      <PipelineStepper
        stage={{ kind: "complete" }}
        job={{ ...reconstructed, status: JobStatus.complete, completedAt: at(1807) }}
        photoCount={38}
      />,
    );

    const steps = screen.getAllByRole("listitem").map(item => item.textContent);
    expect(steps[0]).toContain("Upload photos: done38 photos");
    expect(steps[1]).toContain("Place the cameras: done7m 52sGPU start-up 3m 40s · reconstructing 4m 12s");
    expect(steps[2]).toContain("Check the shape: doneYou took 12m 00s");
    expect(steps[3]).toContain("Build the 3D splat: done10m 15sGPU start-up 3m 05s · training 7m 10s");
    expect(steps[4]).toContain("Share: done");
    expect(screen.getByText("18m 07s of GPU time")).toBeTruthy();
  });

  it("splits start-up into boot and image pull when the worker reported its boot time", () => {
    vi.useFakeTimers({ now: T0 + 1463_000 });
    render(
      <PipelineStepper
        stage={{ kind: "building", progress: 20, startedAt: reconstructed.trainingStartedAt }}
        job={{ ...reconstructed, colmapBootedAt: at(70) }}
        photoCount={38}
      />,
    );

    expect(screen.getByText("Boot 1m 10s · image pull 2m 30s · reconstructing 4m 12s")).toBeTruthy();
  });
});
