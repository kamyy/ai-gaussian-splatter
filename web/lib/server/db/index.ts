import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { getEnv } from "../env";
import * as schema from "./schema";

/**
 * Cached on globalThis because the dev server re-evaluates modules on every hot
 * reload; without it each reload opens a new connection pool and eventually
 * exhausts Postgres's connection limit.
 *
 * drizzle-orm and pg are both pure JS with no native binary, so `next build`'s
 * standalone file tracing picks them up without special handling.
 */
const globalForDb = globalThis as unknown as {
  pool?: Pool;
  db?: NodePgDatabase<typeof schema>;
};

export function getDb(): NodePgDatabase<typeof schema> {
  if (globalForDb.db === undefined) {
    globalForDb.pool = new Pool({ connectionString: getEnv().DATABASE_URL });
    globalForDb.db = drizzle(globalForDb.pool, { schema });
  }
  return globalForDb.db;
}

/**
 * Tests must call this in `afterAll` — an open pg Pool keeps the event loop
 * alive, and Vitest hangs at the end of the run rather than exiting.
 */
export async function closeDb(): Promise<void> {
  await globalForDb.pool?.end();
  globalForDb.pool = undefined;
  globalForDb.db = undefined;
}
