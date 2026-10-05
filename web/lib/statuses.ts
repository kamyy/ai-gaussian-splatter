/**
 * The status values for splats, photos, and worker jobs, shared by the database, the API, and the UI.
 *
 * These live outside web/lib/server/ because client components must not import from it, since that would pull the
 * database client and AWS SDK into the browser bundle. The dependency runs the safe direction instead:
 * web/lib/server/db/schema.ts imports these enums and hands them to Drizzle's pgEnum, so the Postgres enum labels and
 * the TypeScript types cannot drift apart.
 *
 * Values are snake_case because they are also the Postgres enum labels, so there is exactly one spelling from the
 * database through to the JSON responses. Public JSON field names stay camelCase. The worker's status callback and S3
 * credentials requests use snake_case field names. SplatStatus.draft is the string "draft", and the same is true of
 * every member here, so a comparison can name the status.
 *
 * Declaration order of each enum is its Postgres enum order. Adding a member, at any position, generates a plain
 * ALTER TYPE … ADD VALUE. Moving or removing one makes drizzle-kit drop and recreate the type around the column that
 * uses it. Follow .claude/skills/db-migration/SKILL.md for that migration.
 */

/** Where a splat is in capture and processing. */
export enum SplatStatus {
  draft = "draft",
  uploading = "uploading",
  ready_to_process = "ready_to_process",
  processing = "processing",
  complete = "complete",
  failed = "failed",
}

/** Whether a photo's upload to storage has finished. */
export enum PhotoUploadStatus {
  pending = "pending",
  uploaded = "uploaded",
  failed = "failed",
}

/** Where a worker job is in the reconstruct and train pipeline. */
export enum JobStatus {
  queued = "queued",
  launching = "launching",
  reconstruction_running = "reconstruction_running",
  awaiting_training = "awaiting_training",
  training_running = "training_running",
  uploading_result = "uploading_result",
  complete = "complete",
  failed = "failed",
  cancelled = "cancelled",
}

export const JOB_ENDED_STATUSES: JobStatus[] = [JobStatus.complete, JobStatus.failed, JobStatus.cancelled];
