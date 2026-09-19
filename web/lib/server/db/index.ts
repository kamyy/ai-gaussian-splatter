import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { DatabaseError, Pool, type PoolClient } from "pg";

import { clearDatabasePasswordCache, databaseSsl, fetchDatabasePassword } from "../databaseUrl";
import { getEnv } from "../env";
import * as schema from "./schema";

const globalForDb = globalThis as {
  // Cache in globalThis because the dev server re-evaluates modules on every hot reload; without it each reload opens a
  // new connection pool and eventually exhausts Postgres's connection limit.
  pgDb?: NodePgDatabase<typeof schema>;
  pool?: Pool;
};

type ConnectCallback = (
  err: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: Error | boolean) => void,
) => void;

/**
 * A pool whose `password` callback is `fetchDatabasePassword`. That password is cached, so right after an RDS rotation
 * new connections offer the old one and Postgres rejects them with `28P01`. On that error this clears the cache and
 * retries once, and the retry fetches the rotated password.
 *
 * Overriding `connect` covers every path: `pool.query` calls it with a callback, and drizzle's `transaction()` awaits
 * it. `pg` reports a failed connection attempt only to that caller, not as a pool event.
 */
export class SecretPasswordPool extends Pool {
  override connect(): Promise<PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<PoolClient> | undefined {
    const connected = super.connect().catch((err: unknown) => {
      if (!(err instanceof DatabaseError && err.code === "28P01")) {
        throw err;
      }
      clearDatabasePasswordCache();
      return super.connect();
    });
    if (!callback) {
      return connected;
    }
    connected.then(
      client => callback(undefined, client, client.release),
      (err: Error) => callback(err, undefined, () => {}),
    );
    return undefined;
  }
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!globalForDb.pgDb) {
    // Discrete fields rather than a connectionString: pg's dynamic `password` callback (a function re-run on every
    // new physical connection, not just once) only works in this form. See fetchDatabasePassword's own comment for
    // why the web service needs that and the static DATABASE_PASSWORD env var used elsewhere doesn't suffice here.
    const {
      DATABASE_HOST,
      DATABASE_PORT,
      DATABASE_NAME,
      DATABASE_USER,
      DATABASE_PASSWORD,
      DATABASE_SECRET_ARN,
      AWS_REGION,
    } = getEnv();
    const options = {
      host: DATABASE_HOST,
      port: DATABASE_PORT,
      database: DATABASE_NAME,
      user: DATABASE_USER,
      ssl: databaseSsl(),
    };
    globalForDb.pool = DATABASE_SECRET_ARN
      ? new SecretPasswordPool({ ...options, password: () => fetchDatabasePassword(DATABASE_SECRET_ARN, AWS_REGION) })
      : new Pool({ ...options, password: DATABASE_PASSWORD });
    globalForDb.pool.on("error", err => {
      // Without this, a single dead idle connection takes down the process. `pg` re-emits errors from idle pooled
      // clients on the Pool itself, and an unhandled "error" event on an EventEmitter is an uncaught exception. So an
      // RDS failover, a maintenance reboot, or any server-side idle reap would kill the whole task and drop every
      // in-flight request instead of the pool quietly discarding one client.
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
