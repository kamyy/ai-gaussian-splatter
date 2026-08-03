// Mirrors backend/app/schemas.py — kept in sync by hand for now; a generated
// OpenAPI client is a reasonable future upgrade once the API stabilizes.

export type ObjectStatus = "draft" | "uploading" | "ready_to_process" | "processing" | "complete" | "failed";

export type JobStatus =
  | "queued"
  | "launching"
  | "colmap_running"
  | "training_running"
  | "uploading_result"
  | "complete"
  | "failed"
  | "cancelled";

export const TERMINAL_JOB_STATUSES: JobStatus[] = ["complete", "failed", "cancelled"];

export interface ObjectRead {
  id: string;
  name: string;
  status: ObjectStatus;
  thumbnail_s3_key: string | null;
  is_shareable: boolean;
  created_at: string;
}

export interface PhotoPresignItem {
  photo_id: string;
  presigned_put_url: string;
  s3_key: string;
}

export interface JobRead {
  id: string;
  object_id: string;
  status: JobStatus;
  error_message: string | null;
  result_s3_key: string | null;
  thumbnail_s3_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface GalleryItemRead {
  id: string;
  title: string;
  description: string | null;
  thumbnail_url: string;
  splat_url: string;
}

export interface PublicObjectRead {
  title: string;
  thumbnail_url: string;
  splat_url: string;
}
