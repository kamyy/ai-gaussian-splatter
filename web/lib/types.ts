// Wire types for the REST API in web/app/api/v1/. The status values these reference live in web/lib/statuses.ts.

import type { JobStatus, SplatStatus } from "./statuses";

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
