import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { databaseSsl } from "../databaseUrl";
import { getEnv } from "../env";
import * as schema from "./schema";

const globalForDb = globalThis as {
  // Cache in globalThis because the dev server re-evaluates modules on every hot reload; without it each reload opens a
  // new connection pool and eventually exhausts Postgres's connection limit.
  pgDb?: NodePgDatabase<typeof schema>;
  pool?: Pool;
};

export function getDb(): NodePgDatabase<typeof schema> {
  if (!globalForDb.pgDb) {
    globalForDb.pool = new Pool({
      connectionString: getEnv().DATABASE_URL,
      ssl: databaseSsl(),
    });
    globalForDb.pool.on("error", err => {
      // Without this, a single dead idle connection takes down the process. `pg` re-emits errors from idle pooled clients
      // on the Pool itself, and an unhandled "error" event on an EventEmitter is an uncaught exception. So an RDS
      // failover, a maintenance reboot, or any server-side idle reap would kill the whole task and drop every in-flight
      // request instead of the pool quietly discarding one client.
      console.error("Idle pg client error (connection discarded):", err);
    });
    globalForDb.pgDb = drizzle(globalForDb.pool, { schema });
  }
  return globalForDb.pgDb;
}

/**
 * Tests must call this in `afterAll`. An open pg Pool keeps the event loop alive, and Vitest hangs at the end of the
 * run rather than exiting.
 */
export async function closeDb(): Promise<void> {
  if (globalForDb.pool) {
    await globalForDb.pool.end();
    globalForDb.pool = undefined;
  }
  if (globalForDb.pgDb) {
    globalForDb.pgDb = undefined;
  }
}
