import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { databaseSsl } from "../databaseUrl";
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
    const pool = new Pool({ connectionString: getEnv().DATABASE_URL, ssl: databaseSsl() });

    // Without this, a single dead idle connection takes down the process.
    // `pg` re-emits errors from idle pooled clients on the Pool itself, and an
    // unhandled "error" event on an EventEmitter is an uncaught exception —
    // so an RDS failover, a maintenance reboot, or any server-side idle reap
    // would kill the whole task and drop every in-flight request instead of
    // the pool quietly discarding one client.
    pool.on("error", error => {
      console.error("Idle pg client error (connection discarded):", error);
    });

    globalForDb.pool = pool;
    globalForDb.db = drizzle(pool, { schema });
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
