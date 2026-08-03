import type { Prisma } from "@prisma/client";

/**
 * Response field sets, replacing what Pydantic's `response_model` used to
 * enforce in the FastAPI backend.
 *
 * These are `select` clauses rather than post-hoc field stripping so the
 * omissions are guaranteed at the query, not by remembering to delete keys.
 * That matters most for Job: `callbackToken` is the worker's per-job bearer
 * credential and `ec2InstanceId` is internal infrastructure detail — neither
 * was in the old JobRead schema and neither may ever reach a client.
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
