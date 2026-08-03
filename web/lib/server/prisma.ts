import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { getEnv } from "./env";

/**
 * Cached on globalThis because the dev server re-evaluates modules on every hot
 * reload; without it each reload opens a new connection pool and eventually
 * exhausts Postgres's connection limit.
 *
 * Prisma 7 requires an explicit driver adapter — the connection URL lives in
 * prisma.config.ts, not schema.prisma.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: getEnv().DATABASE_URL }),
  });
}

export function getPrisma(): PrismaClient {
  globalForPrisma.prisma ??= createPrismaClient();
  return globalForPrisma.prisma;
}
