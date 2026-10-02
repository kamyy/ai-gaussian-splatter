import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Applies migrations once before the server Vitest project runs (see web/vitest.config.mts), so a fresh Postgres (the
 * CI container, or a local database that has never been migrated) has the schema. CI also runs `pnpm db:migrate`
 * before Vitest. This covers a local `pnpm test`, where nothing else migrated first.
 *
 * Throws when TEST_DATABASE_URL is empty, because web/vitest.config.mts defaults it only when unset. The
 * database-backed tests then fail the run instead of being skipped.
 *
 * Uses drizzle's programmatic migrator rather than running drizzle-kit as a subprocess, and reads the URL directly
 * instead of going through web/drizzle.config.ts. Its pool is separate from the one the tests use and must be closed
 * here, or Vitest hangs before a single test runs.
 */
export async function setup(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "TEST_DATABASE_URL is empty. Unset it to use the default from web/vitest.config.mts, " +
        "and start Postgres with `scripts/dev/db.sh up`.",
    );
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }
}
