import type { Prisma } from "@prisma/client";

/**
 * Which columns responses may expose.
 *
 * `select` clauses rather than deleting keys afterwards, so the omissions are
 * enforced by the query. Job matters most: `callbackToken` is the worker's
 * bearer credential and `ec2InstanceId` is internal — neither may reach a client.
 */

export const splatReadSelect = {
  id: true,
  name: true,
  status: true,
  thumbnailS3Key: true,
  isShareable: true,
  createdAt: true,
} satisfies Prisma.SplatSelect;

export const jobReadSelect = {
  id: true,
  splatId: true,
  status: true,
  errorMessage: true,
  resultS3Key: true,
  thumbnailS3Key: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.JobSelect;

export type SplatRead = Prisma.SplatGetPayload<{ select: typeof splatReadSelect }>;
export type JobRead = Prisma.JobGetPayload<{ select: typeof jobReadSelect }>;
