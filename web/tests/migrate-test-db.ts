import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Applies migrations once before the server Vitest project runs (see vitest.config.mts), so a fresh Postgres (CI
 * container or a local DB that has never been migrated) has the schema. Throws when TEST_DATABASE_URL is unset, so
 * the database-backed tests fail the run instead of skipping. CI also runs `pnpm db:migrate` before Vitest; this is
 * the belt for a local `pnpm test`.
 *
 * Uses the programmatic migrator rather than shelling out to drizzle-kit: no subprocess, and it reads the URL directly
 * instead of going through drizzle.config.ts. Its pool is separate from the one the tests use and must be closed here,
 * or Vitest hangs before a single test runs.
 */
export default async function setup(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "TEST_DATABASE_URL is unset. Run scripts/dev/create-dev-resources.sh to create web/.env with it. " +
        "Then start Postgres with scripts/dev/db-up.sh.",
    );
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }
}
