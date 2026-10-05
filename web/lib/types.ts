/**
 * The TypeScript shapes of the REST API's JSON: what each endpoint in web/app/api/v1/ sends and receives.
 *
 * The browser and the Route Handlers both import these, so a field renamed on one side fails the type check on the
 * other. The status values they reference live in web/lib/statuses.ts.
 */

import type { JobStatus, SplatStatus } from "./statuses";

export interface Splat {
  id: string;
  name: string;
  status: SplatStatus;
  thumbnailS3Key: string | null;
  isShareable: boolean;
  createdAt: string;
}

/**
 * GET /api/v1/splats: what a library card needs for each splat, without one API call per card. thumbnailPhotoUrl is a
 * presigned GET for the first uploaded photo's thumbnail, or for the photo itself when it has none. That differs from
 * Splat.thumbnailS3Key, the Open Graph preview the worker renders once a job completes. A crop leaves it in place.
 * photoCount counts uploaded photos only. thumbnailWidth and thumbnailHeight are that photo's
 * size, null when there is no photo or no size was recorded.
 */
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

/**
 * width and height are null when the photo's display size was not recorded. thumbnailUrl is the photo's small copy.
 * When the photo has no thumbnail, thumbnailUrl is the original.
 */
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
  resultPlyS3Key: string | null;
  thumbnailS3Key: string | null;
  pointCloudS3Key: string | null;
  // Each stage's timestamps, which web/lib/stageTimings.ts turns into durations. A *BootedAt is when the stage's
  // instance finished booting. A *StartedAt comes from the worker's first callback after its image pull. A local run
  // omits booted_at, so the *BootedAt fields stay null. The status route still stamps *StartedAt from the callback
  // clock. trainingLaunchedAt is null until the train stage is launched.
  colmapBootedAt: string | null;
  colmapStartedAt: string | null;
  colmapFinishedAt: string | null;
  trainingLaunchedAt: string | null;
  trainingBootedAt: string | null;
  trainingStartedAt: string | null;
  // When the worker reported the job complete. Null until then.
  completedAt: string | null;
  // Percent of training done, 0-100. Null until the train stage's worker first reports it.
  trainingProgress: number | null;
  // The box the finished splat is cropped to. Null while the download and the viewers serve the uncropped splat.
  cropBox: CropBox | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * GET /api/v1/splats/[splatId]/cameras: where each photo COLMAP placed was taken from, in the point cloud's own
 * coordinate frame. center is the camera's position in world space. rotation is COLMAP's world-to-camera rotation as
 * three rows, with the camera looking along its own +z. width, height, fx, and fy are the photo's size and focal
 * lengths in pixels, as COLMAP estimated them.
 */
export interface CameraPose {
  photoId: string;
  center: [number, number, number];
  rotation: [number, number, number][];
  width: number;
  height: number;
  fx: number;
  fy: number;
}

/**
 * POST /api/v1/splats/[splatId]/crop's body, and Job.cropBox. An oriented box in the splat's coordinate frame: size is
 * the full edge length on each of the box's own axes, and quaternion is x, y, z, w, as three.js orders it. The crop
 * keeps every Gaussian whose center falls inside it.
 */
export interface CropBox {
  center: [number, number, number];
  size: [number, number, number];
  quaternion: [number, number, number, number];
}

/** GET /api/v1/processing: false while processing is paused for the whole site. */
export interface ProcessingStatus {
  enabled: boolean;
}

/** pointCloudUrl is null when the splat has no point cloud. */
export interface PublicSplat {
  title: string;
  /** True for a splat the / landing page shows as an example. */
  isShowcase: boolean;
  thumbnailUrl: string;
  splatUrl: string;
  pointCloudUrl: string | null;
  /** The owner's crop, which splatUrl's file already has. The viewer hides the point cloud's points outside it too. */
  cropBox: CropBox | null;
}

/**
 * A photo as the public share page shows it. thumbnailUrl is always the browser-made small copy, which carries no
 * EXIF data such as GPS position. originalFilename is a stand-in like "Photo 3", so the owner's filenames stay private.
 */
export type PublicPhoto = Omit<PhotoListItem, "url">;

/** A worker job's stage timestamps, which web/lib/stageTimings.ts turns into durations. */
export type JobTimestamps = Pick<
  Job,
  | "colmapBootedAt"
  | "colmapStartedAt"
  | "colmapFinishedAt"
  | "trainingLaunchedAt"
  | "trainingBootedAt"
  | "trainingStartedAt"
  | "completedAt"
  | "createdAt"
>;

/** timestamps belong to the complete worker job that produced the splat. */
export interface PublicSplatView extends PublicSplat {
  photos: PublicPhoto[];
  timestamps: JobTimestamps;
}

/**
 * One of the examples on the / landing page, which anyone can open at /preview/splats/[id]. It carries the fields a
 * library card shows. thumbnailPhotoUrl is the first photo's browser-made small copy, never the original, so it carries
 * no EXIF data.
 */
export type ExampleSplat = Pick<
  SplatListItem,
  "id" | "name" | "photoCount" | "thumbnailPhotoUrl" | "thumbnailWidth" | "thumbnailHeight"
>;
