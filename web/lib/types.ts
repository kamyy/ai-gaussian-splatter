// Wire types for the REST API in web/app/api/v1/, and the authoritative status value lists.
//
// The status tuples live here rather than in the schema because client components must not import from
// web/lib/server/ (that would pull the database client and AWS SDK into the browser bundle). The dependency runs the
// safe direction instead: web/lib/server/db/schema.ts imports these tuples and hands them to pgEnum, so the Postgres
// enum labels and the TypeScript unions cannot drift apart.
//
// Values are snake_case because they are simultaneously the Postgres enum labels, so there is exactly one spelling from
// the database through to the JSON responses. Field *names* stay camelCase; only these values are snake_case.

export const SPLAT_STATUSES = ["draft", "uploading", "ready_to_process", "processing", "complete", "failed"] as const;
export type SplatStatus = (typeof SPLAT_STATUSES)[number];

export const PHOTO_UPLOAD_STATUSES = ["pending", "uploaded", "failed"] as const;

// The most photos one splat can hold. COLMAP's exhaustive matcher (worker/pipeline/sfm.py) compares every pair of
// photos, so reconstruct time grows with the square of this number. 100 is twice the capture guide's target of 50. It
// lives here rather than in web/lib/server/env.ts because web/components/splats/NewSplatForm.tsx enforces it too.
export const MAX_PHOTOS_PER_SPLAT = 100;

// The largest one photo can be, in bytes. It bounds what a photo costs in S3 storage and in worker download time. The
// worker downsamples every photo to worker/pipeline/train.py's MAX_TRAINING_EDGE, so a bigger file adds nothing to the
// splat. 30 MB still admits a full-resolution phone JPEG or HEIC. web/components/splats/NewSplatForm.tsx enforces it
// too.
export const MAX_PHOTO_BYTES = 30 * 1024 * 1024;

// Named so a comparison uses a member (JobStatus.queued) rather than repeating the label as a string.
export const JobStatus = {
  queued: "queued",
  launching: "launching",
  reconstruction_running: "reconstruction_running",
  awaiting_training: "awaiting_training",
  training_running: "training_running",
  uploading_result: "uploading_result",
  complete: "complete",
  failed: "failed",
  cancelled: "cancelled",
} as const;

// Derived from JobStatus's own values rather than hand-listed a second time, so the two can't drift. The cast is a
// literal tuple, not a plain `JobStatus[]`, because pgEnum (web/lib/server/db/schema.ts) requires a
// `[string, ...string[]]` shape that Object.values()'s inferred `JobStatus[]` doesn't satisfy on its own.
export const JOB_STATUSES = Object.values(JobStatus) as [JobStatus, ...JobStatus[]];
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

// The one status value the app renamed. A worker built before that rename can still be running against a newer database
// (a worker instance runs for up to WORKER_MAX_LIFETIME_MINUTES, which can outlast a deploy), and its callback still
// sends this name. web/app/api/v1/internal/jobs/[jobId]/status/route.ts is the only place that reads it. That route
// turns an incoming "colmap_running" into JobStatus.reconstruction_running before anything else sees it, so nothing
// else needs to know the old name.
export const LEGACY_COLMAP_RUNNING_STATUS = "colmap_running";

// The Postgres enum's own label set: every value the type has ever had, in the order each was added, rather than in
// JOB_STATUSES' order. LEGACY_COLMAP_RUNNING_STATUS stays a valid column value so a stale worker's callback is still
// written instead of rejected, even though JobStatus no longer names it. Postgres has no cheap way to drop an enum
// label short of recreating the whole type, so an added label stays.
//
// Written out in this exact historical order, not derived from JOB_STATUSES, so that `pnpm db:generate` sees a new
// value as a plain append and emits a single ALTER TYPE … ADD VALUE. Reordering the existing values makes drizzle-kit
// drop and recreate the type around the column instead, which .claude/skills/db-migration/SKILL.md flags as unsafe on a
// live table.
type JobStatusDbValue = JobStatus | typeof LEGACY_COLMAP_RUNNING_STATUS;

export const JOB_STATUS_DB_VALUES = [
  JobStatus.queued,
  JobStatus.launching,
  LEGACY_COLMAP_RUNNING_STATUS,
  JobStatus.awaiting_training,
  JobStatus.training_running,
  JobStatus.uploading_result,
  JobStatus.complete,
  JobStatus.failed,
  JobStatus.cancelled,
  JobStatus.reconstruction_running,
] as [JobStatusDbValue, ...JobStatusDbValue[]];

export const JOB_ENDED_STATUSES: JobStatus[] = [JobStatus.complete, JobStatus.failed, JobStatus.cancelled];

export interface Splat {
  id: string;
  name: string;
  status: SplatStatus;
  thumbnailS3Key: string | null;
  isShareable: boolean;
  createdAt: string;
}

// GET /api/v1/splats: what a library card needs for each splat, without one API call per card. thumbnailPhotoUrl is a
// presigned GET for the first uploaded photo's thumbnail, or for the photo itself when it has none. That differs from
// Splat.thumbnailS3Key, the splat preview the worker renders once a job completes. photoCount counts uploaded photos
// only. thumbnailWidth and thumbnailHeight are that photo's size, null when there is no photo or no size was recorded.
export interface SplatListItem extends Splat {
  photoCount: number;
  latestJobStatus: JobStatus | null;
  thumbnailPhotoUrl: string | null;
  thumbnailWidth: number | null;
  thumbnailHeight: number | null;
}

export interface PhotoPresignItem {
  photoId: string;
  presignedPutUrl: string;
  s3Key: string;
  thumbnailPutUrl: string;
}

// width and height are null only for a photo uploaded before sizes were recorded. thumbnailUrl is the photo's small
// copy, or the original for a photo uploaded before thumbnails existed.
export interface PhotoListItem {
  id: string;
  originalFilename: string;
  url: string;
  thumbnailUrl: string;
  width: number | null;
  height: number | null;
}

export interface Job {
  id: string;
  splatId: string;
  status: JobStatus;
  errorMessage: string | null;
  resultS3Key: string | null;
  thumbnailS3Key: string | null;
  pointCloudS3Key: string | null;
  // Each stage's timestamps, which web/lib/stageTimings.ts turns into durations. A *StartedAt comes from the worker's
  // first callback, so it follows the instance's launch by its boot and image pull. trainingLaunchedAt is null for a
  // job trained before it was recorded.
  colmapStartedAt: string | null;
  colmapFinishedAt: string | null;
  trainingLaunchedAt: string | null;
  trainingStartedAt: string | null;
  // Percent of training done, 0-100. Null until the train stage's worker first reports it.
  trainingProgress: number | null;
  createdAt: string;
  updatedAt: string;
}

// GET /api/v1/splats/[splatId]/cameras: where each photo COLMAP placed was taken from, in the point cloud's own
// coordinate frame. center is the camera's position in world space. rotation is COLMAP's world-to-camera rotation as
// three rows, with the camera looking along its own +z. width, height, fx, and fy are the photo's size and focal
// lengths in pixels, as COLMAP estimated them.
export interface CameraPose {
  photoId: string;
  center: [number, number, number];
  rotation: [number, number, number][];
  width: number;
  height: number;
  fx: number;
  fy: number;
}

// POST /api/v1/splats/[splatId]/train's optional body. An oriented box in the point cloud's coordinate frame: size is
// the full edge length on each of the box's own axes, and quaternion is x, y, z, w, as three.js orders it. The train
// stage's worker drops every Gaussian whose center falls outside it.
export interface CropBox {
  center: [number, number, number];
  size: [number, number, number];
  quaternion: [number, number, number, number];
}

export interface PublicSplat {
  title: string;
  thumbnailUrl: string;
  splatUrl: string;
}
