/**
 * How long each GPU stage of a worker job took, and how to show those durations.
 *
 * Splits each stage into the instance's start-up and the work itself, from the timestamps the worker reports. Where the
 * worker also reported when its instance finished booting, start-up splits again into the boot and the image pull.
 * web/components/splats/PipelineStepper.tsx shows them beside its steps.
 */

import { JobStatus } from "./statuses";
import type { Job, JobTimestamps } from "./types";

// The fields of a worker job that stageTimings reads. The share page has these without the rest of the job.
export type TimedJob = JobTimestamps & Pick<Job, "status" | "pointCloudS3Key">;

export interface StepTiming {
  // From the instance's launch to the stage's end, or to now while it runs.
  totalMs: number;
  running: boolean;
  // The instance's boot and image pull, up to the worker's first callback. Null until that callback arrives.
  startupMs: number | null;
  // startupMs's two parts. Null until the first callback, and for a run that reported no boot time.
  bootMs: number | null;
  pullMs: number | null;
  // The stage's own work, so far while it runs. Null until the worker's first callback.
  workMs: number | null;
}

export interface StageTimings {
  cameras: StepTiming | null;
  // The visitor's own time between the point cloud appearing and pressing build.
  checkMs: number | null;
  build: StepTiming | null;
}

function time(iso: string | null): number | null {
  return iso === null ? null : new Date(iso).getTime();
}

function stepTiming(
  launchedAt: number | null,
  bootedAt: number | null,
  startedAt: number | null,
  finishedAt: number | null,
  running: boolean,
  now: number,
): StepTiming | null {
  const end = finishedAt ?? (running ? now : null);
  if (launchedAt === null || end === null) {
    return null;
  }

  // The client's clock can run behind the server's that stamped launchedAt, so a fresh stage could read negative. The
  // instance's clock stamps bootedAt, so it can disagree with the server's the same way.
  const split = bootedAt !== null && startedAt !== null;
  return {
    totalMs: Math.max(0, end - launchedAt),
    running,
    startupMs: startedAt === null ? null : Math.max(0, startedAt - launchedAt),
    bootMs: split ? Math.max(0, bootedAt - launchedAt) : null,
    pullMs: split ? Math.max(0, startedAt - bootedAt) : null,
    workMs: startedAt === null ? null : Math.max(0, end - startedAt),
  };
}

/**
 * A stage that ended without finishing (failed or cancelled) gets no timing, since neither timestamp marks when it
 * stopped. The build stage's end is completedAt, when the worker reported the job complete.
 */
export function stageTimings(job: TimedJob, now: number): StageTimings {
  const placingCameras =
    job.status === JobStatus.queued ||
    job.status === JobStatus.reconstruction_running ||
    (job.status === JobStatus.launching && job.pointCloudS3Key === null);
  const building =
    job.status === JobStatus.training_running ||
    job.status === JobStatus.uploading_result ||
    (job.status === JobStatus.launching && job.pointCloudS3Key !== null);

  const colmapFinishedAt = time(job.colmapFinishedAt);
  const trainingLaunchedAt = time(job.trainingLaunchedAt);

  return {
    cameras: stepTiming(
      time(job.createdAt),
      time(job.colmapBootedAt),
      time(job.colmapStartedAt),
      colmapFinishedAt,
      placingCameras,
      now,
    ),
    checkMs:
      colmapFinishedAt === null || trainingLaunchedAt === null
        ? null
        : Math.max(0, trainingLaunchedAt - colmapFinishedAt),
    build: stepTiming(
      trainingLaunchedAt,
      time(job.trainingBootedAt),
      time(job.trainingStartedAt),
      time(job.completedAt),
      building,
      now,
    ),
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "22s", "7m 52s", "1h 03m": a finished duration. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${pad(seconds % 60)}s`;
  }

  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
}

/** "4:31", "1:02:09": a running clock. */
export function formatClock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}:${pad(seconds % 60)}`;
  }

  return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(seconds % 60)}`;
}
