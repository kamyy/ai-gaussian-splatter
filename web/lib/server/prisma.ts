import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

import { getEnv } from "./env";

/**
 * Prisma Client singleton — replaces the former backend/app/db.py engine +
 * sessionmaker singletons.
 *
 * Cached on globalThis because Next.js's dev server re-evaluates modules on
 * every hot reload; without this, each reload would open a fresh connection
 * pool and eventually exhaust Postgres's connection limit.
 *
 * Prisma 7 requires an explicit driver adapter — the connection URL no longer
 * lives in schema.prisma's datasource block (see prisma.config.ts, which
 * supplies it to the migration CLI instead).
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
