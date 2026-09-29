/**
 * Works out which stage a splat is at, from its latest worker job.
 *
 * The splat's page uses the result to pick the stage card to show and to mark the pipeline's current step. It turns the
 * database's job statuses into the five steps a visitor sees: upload, place the cameras, check the shape, build, and
 * share.
 */

import { JobStatus } from "./statuses";
import type { Job } from "./types";

// The five steps a visitor sees, in order. "cameras" is COLMAP's reconstruction, "check" is the awaiting_training
// pause, and "build" is gsplat's training run.
export const STEPS = [
  { key: "upload", label: "Upload photos" },
  { key: "cameras", label: "Place the cameras" },
  { key: "check", label: "Check the shape" },
  { key: "build", label: "Build the 3D splat" },
  { key: "share", label: "Share" },
] as const;

export type StepKey = (typeof STEPS)[number]["key"];

// What the page's stage card shows. "no_photos" is a dead end: photos can only be added when a splat is created.
export type Stage =
  | { kind: "no_photos" }
  | { kind: "ready" }
  | { kind: "placing_cameras" }
  | { kind: "check" }
  // progress is 0-100, and startedAt the training stage's start. Both are null until the worker first reports.
  | { kind: "building"; progress: number | null; startedAt: string | null }
  | { kind: "complete" }
  | { kind: "failed"; step: StepKey; message: string | null }
  | { kind: "cancelled"; step: StepKey };

export function splatStage(job: Job | undefined, photoCount: number): Stage {
  if (job === undefined) {
    return photoCount === 0 ? { kind: "no_photos" } : { kind: "ready" };
  }
  switch (job.status) {
    case JobStatus.queued:
    case JobStatus.reconstruction_running:
      return { kind: "placing_cameras" };
    // Both stages launch through "launching". The train stage's launch starts from a job that already has a point cloud.
    case JobStatus.launching:
      if (job.pointCloudS3Key) {
        return { kind: "building", progress: null, startedAt: null };
      }
      return { kind: "placing_cameras" };
    case JobStatus.awaiting_training:
      return { kind: "check" };
    case JobStatus.training_running:
      return { kind: "building", progress: job.trainingProgress, startedAt: job.trainingStartedAt };
    case JobStatus.uploading_result:
      return { kind: "building", progress: 100, startedAt: job.trainingStartedAt };
    case JobStatus.complete:
      return { kind: "complete" };
    // The job keeps no record of which stage it ended in. Reconstruction is what writes the point cloud, so a job
    // that has one got past placing the cameras. "launching" above goes by the same test.
    case JobStatus.failed:
      return { kind: "failed", step: job.pointCloudS3Key ? "build" : "cameras", message: job.errorMessage };
    case JobStatus.cancelled:
      return { kind: "cancelled", step: job.pointCloudS3Key ? "build" : "cameras" };
  }
}

// The step the stepper marks as current. Every step before it shows as done. null means every step is done.
export function currentStep(stage: Stage): StepKey | null {
  switch (stage.kind) {
    case "no_photos":
      return "upload";
    case "ready":
    case "placing_cameras":
      return "cameras";
    case "check":
      return "check";
    case "building":
      return "build";
    case "complete":
      return null;
    case "failed":
    case "cancelled":
      return stage.step;
  }
}
