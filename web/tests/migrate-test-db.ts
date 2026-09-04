import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Applies migrations once before the server Vitest project runs (see vitest.config.mts), so a fresh Postgres (CI
 * container or a local DB that has never been migrated) has the schema. No-op when TEST_DATABASE_URL is unset — those
 * tests skip anyway. CI also runs `pnpm db:migrate` before Vitest; this is the belt for a bare `TEST_DATABASE_URL=…
 * pnpm test`.
 *
 * Uses the programmatic migrator rather than shelling out to drizzle-kit: no subprocess, and it reads the URL directly
 * instead of going through drizzle.config.ts. Its pool is separate from the one the tests use and must be closed here,
 * or Vitest hangs before a single test runs.
 */
export default async function setup(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }
}
