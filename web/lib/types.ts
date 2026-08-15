// Wire types for the REST API in app/api/v1/, and the authoritative status
// value lists.
//
// The status tuples live here rather than in the schema because client
// components must not import from lib/server/ (that would pull the database
// client and AWS SDK into the browser bundle). The dependency runs the safe
// direction instead: lib/server/db/schema.ts imports these tuples and hands
// them to pgEnum, so the Postgres enum labels and the TypeScript unions cannot
// drift apart.
//
// Values are snake_case because they are simultaneously the Postgres enum
// labels, so there is exactly one spelling from the database through to the
// JSON responses. Field *names* stay camelCase; only these values are
// snake_case.

export const SPLAT_STATUSES = ["draft", "uploading", "ready_to_process", "processing", "complete", "failed"] as const;
export type SplatStatus = (typeof SPLAT_STATUSES)[number];

export const PHOTO_UPLOAD_STATUSES = ["pending", "uploaded", "failed"] as const;
export type PhotoUploadStatus = (typeof PHOTO_UPLOAD_STATUSES)[number];

export const JOB_STATUSES = [
  "queued",
  "launching",
  "colmap_running",
  "training_running",
  "uploading_result",
  "complete",
  "failed",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_ENDED_STATUSES: JobStatus[] = ["complete", "failed", "cancelled"];

export interface ObjectRead {
  id: string;
  name: string;
  status: SplatStatus;
  thumbnailS3Key: string | null;
  isShareable: boolean;
  createdAt: string;
}

export interface PhotoPresignItem {
  photoId: string;
  presignedPutUrl: string;
  s3Key: string;
}

export interface JobRead {
  id: string;
  splatId: string;
  status: JobStatus;
  errorMessage: string | null;
  resultS3Key: string | null;
  thumbnailS3Key: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GalleryItemRead {
  id: string;
  title: string;
  description: string | null;
  thumbnailUrl: string;
  splatUrl: string;
}

export interface PublicObjectRead {
  title: string;
  thumbnailUrl: string;
  splatUrl: string;
}
