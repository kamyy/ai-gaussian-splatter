// Wire types for the REST API in app/api/v1/.
//
// These used to mirror backend/app/schemas.py by hand. Now the API is in this
// same TypeScript program, so the authoritative shapes are derived from Prisma
// in lib/server/selects.ts — these stay hand-written only because client
// components must not import from lib/server/ (it would pull the Prisma client
// and AWS SDK into the browser bundle). Keep them in sync with that file.
//
// Field names and enum values are camelCase/PascalCase because responses
// serialize Prisma records directly, with no mapping layer.

export type SplatStatus = "Draft" | "Uploading" | "ReadyToProcess" | "Processing" | "Complete" | "Failed";

export type JobStatus =
  | "Queued"
  | "Launching"
  | "ColmapRunning"
  | "TrainingRunning"
  | "UploadingResult"
  | "Complete"
  | "Failed"
  | "Cancelled";

export const TERMINAL_JOB_STATUSES: JobStatus[] = ["Complete", "Failed", "Cancelled"];

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
