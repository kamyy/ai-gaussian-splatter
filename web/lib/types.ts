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

// The one status value the app renamed: a worker built before that rename can still be running against a new
// database (a worker instance runs for up to WORKER_MAX_LIFETIME_MINUTES, which can outlast a deploy), and its
// callback still sends this name. web/app/api/v1/internal/jobs/[jobId]/status/route.ts is the only place that reads
// this — it normalizes an incoming "colmap_running" to JobStatus.reconstruction_running before anything else in the
// app sees it, so nothing else ever needs to know the old name existed.
export const LEGACY_COLMAP_RUNNING_STATUS = "colmap_running";

// The Postgres enum's own label set: every value the type has ever had, in the order each was added, rather than
// JOB_STATUSES' own (cleaner, but different) order. LEGACY_COLMAP_RUNNING_STATUS stays a valid column value so a
// stale worker's callback still writes instead of getting rejected, even though JobStatus itself no longer names
// it. Postgres has no cheap way to drop an enum label (only recreating the whole type), so once added it stays
// rather than getting removed in a later release the way a column or constraint would.
//
// Written out in this exact historical order, not derived from JOB_STATUSES, so `pnpm db:generate` sees the new
// value as a plain append and emits a single ALTER TYPE … ADD VALUE — reordering the existing values here instead
// makes drizzle-kit conclude the type needs dropping and recreating around the column, which the db-migration
// skill flags as unsafe against a live table.
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

// GET /api/v1/splats — what a library card needs per splat without an N+1 call per card. thumbnailPhotoUrl is a
// presigned GET for the first uploaded photo, distinct from Splat.thumbnailS3Key (the worker-rendered splat preview,
// only set once a job completes). photoCount counts uploaded photos only.
export interface SplatListItem extends Splat {
  photoCount: number;
  latestJobStatus: JobStatus | null;
  thumbnailPhotoUrl: string | null;
}

export interface PhotoPresignItem {
  photoId: string;
  presignedPutUrl: string;
  s3Key: string;
}

export interface PhotoListItem {
  id: string;
  originalFilename: string;
  url: string;
}

export interface Job {
  id: string;
  splatId: string;
  status: JobStatus;
  errorMessage: string | null;
  resultS3Key: string | null;
  thumbnailS3Key: string | null;
  pointCloudS3Key: string | null;
  trainingStartedAt: string | null;
  // Percent of training done, 0-100. Null until the train stage's worker first reports it.
  trainingProgress: number | null;
  createdAt: string;
  updatedAt: string;
}

// GET /api/v1/splats/[splatId]/cameras — where each photo COLMAP placed was taken from, in the point cloud's own
// coordinate frame. center is the camera's world-space position. rotation is COLMAP's world-to-camera rotation, three
// rows, with the camera looking along its own +z. width, height, fx, and fy are the photo's size and focal lengths in
// pixels, as COLMAP estimated them.
export interface CameraPose {
  photoId: string;
  center: [number, number, number];
  rotation: [number, number, number][];
  width: number;
  height: number;
  fx: number;
  fy: number;
}

export interface PublicSplat {
  title: string;
  thumbnailUrl: string;
  splatUrl: string;
}
