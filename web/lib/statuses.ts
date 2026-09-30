/**
 * The status values for splats, photos and jobs, shared by the database, the API and the UI.
 *
 * These live outside web/lib/server/ because client components must not import from it, since that would pull the
 * database client and AWS SDK into the browser bundle. The dependency runs the safe direction instead:
 * web/lib/server/db/schema.ts imports these lists and hands them to Drizzle's pgEnum, so the Postgres enum labels and
 * the TypeScript types cannot drift apart.
 *
 * Values are snake_case because they are also the Postgres enum labels, so there is exactly one spelling from the
 * database through to the JSON responses. Field names stay camelCase. Only these values are snake_case.
 */

export const SPLAT_STATUSES = ["draft", "uploading", "ready_to_process", "processing", "complete", "failed"] as const;

export const PHOTO_UPLOAD_STATUSES = ["pending", "uploaded", "failed"] as const;

/** Named so a comparison uses a member (JobStatus.queued) rather than repeating the label as a string. */
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

/**
 * Derived from JobStatus's own values rather than hand-listed a second time, so the two can't drift. The cast is a
 * literal tuple, not a plain `JobStatus[]`, because pgEnum (web/lib/server/db/schema.ts) requires a
 * `[string, ...string[]]` shape that Object.values()'s inferred `JobStatus[]` doesn't satisfy on its own.
 */
export const JOB_STATUSES = Object.values(JobStatus) as [JobStatus, ...JobStatus[]];

// The Postgres enum's own label set: every value the type has ever had, in the order each was added, rather than in
// JOB_STATUSES' order. "colmap_running" is a label nothing writes any more. Postgres has no cheap way to drop an enum
// label short of recreating the whole type, so it stays in the list.
//
// Written out in this exact order, not derived from JOB_STATUSES, so that `pnpm db:generate` sees a new value as a
// plain append and emits a single ALTER TYPE … ADD VALUE. Reordering the existing values makes drizzle-kit drop and
// recreate the type around the column instead, which .claude/skills/db-migration/SKILL.md flags as unsafe on a live
// table.
export const JOB_STATUS_DB_VALUES = [
  JobStatus.queued,
  JobStatus.launching,
  "colmap_running",
  JobStatus.awaiting_training,
  JobStatus.training_running,
  JobStatus.uploading_result,
  JobStatus.complete,
  JobStatus.failed,
  JobStatus.cancelled,
  JobStatus.reconstruction_running,
] as [JobStatusDbValue, ...JobStatusDbValue[]];

export const JOB_ENDED_STATUSES: JobStatus[] = [JobStatus.complete, JobStatus.failed, JobStatus.cancelled];

export type SplatStatus = (typeof SPLAT_STATUSES)[number];

export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

type JobStatusDbValue = JobStatus | "colmap_running";
