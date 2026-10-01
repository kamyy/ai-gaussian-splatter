/**
 * Which database columns API responses may expose.
 *
 * Column maps are passed to Drizzle's `.select()` rather than deleting keys from the result, so the SQL itself enforces
 * what's left out. Excluded columns are never fetched at all. This matters most for jobs: `callbackToken` is the
 * worker's bearer credential and `ec2InstanceId` is internal, and neither may reach a client.
 *
 * It also holds the order every list of a splat's photos uses, so "Photo 3" names the same photo on every page.
 */

import { asc } from "drizzle-orm";

import { jobs, photos, splats } from "./db/schema";

export const splatColumns = {
  id: splats.id,
  name: splats.name,
  status: splats.status,
  thumbnailS3Key: splats.thumbnailS3Key,
  isShareable: splats.isShareable,
  createdAt: splats.createdAt,
};

export const jobColumns = {
  id: jobs.id,
  splatId: jobs.splatId,
  status: jobs.status,
  errorMessage: jobs.errorMessage,
  resultS3Key: jobs.resultS3Key,
  thumbnailS3Key: jobs.thumbnailS3Key,
  pointCloudS3Key: jobs.pointCloudS3Key,
  colmapBootedAt: jobs.colmapBootedAt,
  colmapStartedAt: jobs.colmapStartedAt,
  colmapFinishedAt: jobs.colmapFinishedAt,
  trainingLaunchedAt: jobs.trainingLaunchedAt,
  trainingBootedAt: jobs.trainingBootedAt,
  trainingStartedAt: jobs.trainingStartedAt,
  trainingProgress: jobs.trainingProgress,
  createdAt: jobs.createdAt,
  updatedAt: jobs.updatedAt,
};

export const photoColumns = {
  id: photos.id,
  splatId: photos.splatId,
  s3Key: photos.s3Key,
  originalFilename: photos.originalFilename,
  width: photos.width,
  height: photos.height,
  thumbnailS3Key: photos.thumbnailS3Key,
  createdAt: photos.createdAt,
};

/**
 * Oldest taken first, for `.orderBy(...photoOrder)`. Postgres sorts a null taken_at last, and upload time then id break
 * ties, so the order never shifts between requests.
 */
export const photoOrder = [asc(photos.takenAt), asc(photos.createdAt), asc(photos.id)];
