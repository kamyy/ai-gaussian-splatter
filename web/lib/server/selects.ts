import { jobs, photos, splats } from "./db/schema";

/**
 * Which columns responses may expose.
 *
 * Column maps are passed to `.select()` rather than deleting keys from the result, so the SQL itself enforces what's
 * left out. Excluded columns are never fetched at all. This matters most for jobs: `callbackToken` is the worker's
 * bearer credential and `ec2InstanceId` is internal, and neither may reach a client.
 */

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
  createdAt: photos.createdAt,
};
