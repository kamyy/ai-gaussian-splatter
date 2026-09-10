import { jobs, splats } from "./db/schema";

/**
 * Which columns responses may expose.
 *
 * Column maps passed to `.select()` rather than deleting keys afterwards, so the omissions are enforced by the SQL —
 * the excluded columns are never fetched at all. Job matters most: `callbackToken` is the worker's bearer credential
 * and `ec2InstanceId` is internal. Neither may reach a client.
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
  colmapPointCloudS3Key: jobs.colmapPointCloudS3Key,
  createdAt: jobs.createdAt,
  updatedAt: jobs.updatedAt,
};
