import { jobs, splats } from "./db/schema";

/**
 * Which columns responses may expose.
 *
 * Column maps passed to `.select()` rather than deleting keys afterwards, so the omissions are enforced by the SQL —
 * the excluded columns are never fetched at all. Job matters most: `callbackToken` is the worker's bearer credential
 * and `ec2InstanceId` is internal — neither may reach a client.
 */

export const splatReadColumns = {
  id: splats.id,
  name: splats.name,
  status: splats.status,
  thumbnailS3Key: splats.thumbnailS3Key,
  isShareable: splats.isShareable,
  createdAt: splats.createdAt,
};

export const jobReadColumns = {
  id: jobs.id,
  splatId: jobs.splatId,
  status: jobs.status,
  errorMessage: jobs.errorMessage,
  resultS3Key: jobs.resultS3Key,
  thumbnailS3Key: jobs.thumbnailS3Key,
  createdAt: jobs.createdAt,
  updatedAt: jobs.updatedAt,
};

export type SplatRead = Pick<typeof splats.$inferSelect, keyof typeof splatReadColumns>;
export type JobRead = Pick<typeof jobs.$inferSelect, keyof typeof jobReadColumns>;
