/**
 * Applies the database migrations in web/drizzle/.
 *
 * `pnpm db:migrate` runs it in local dev and .github/workflows/ci.yml. The migrator image's CMD (web/Dockerfile) runs
 * it directly with node, as the one-off task the deploy runs before the new release goes live. drizzle-kit migrate
 * can exit 1 without printing any error (drizzle-team/drizzle-orm#5521), so this script applies the SQL itself.
 *
 * It is CommonJS so Node doesn't reparse the TypeScript modules it requires as modules of unknown type, which prints a
 * warning on every run. Those are web/lib/server/databaseUrl.ts and web/lib/server/env.ts.
 */

const path = require("node:path");
const { drizzle } = require("drizzle-orm/node-postgres");
const { migrate } = require("drizzle-orm/node-postgres/migrator");
const { Pool } = require("pg");

const { databaseSsl, resolveDatabaseUrl } = require("../lib/server/databaseUrl.ts");
const { isLocalDevEnv, LOCAL_DATABASE_ENV } = require("../lib/server/env.ts");

// Locally, __dirname is web/scripts/, so this resolves to web/drizzle/. In the migrator image, __dirname is
// /app/scripts/, so this resolves to /app/drizzle/.
const migrationsFolder = path.join(__dirname, "..", "drizzle");

async function main() {
  const url = resolveDatabaseUrl(isLocalDevEnv() ? LOCAL_DATABASE_ENV : process.env);
  if (url === undefined) {
    console.error(
      "No database configured: DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USER and DATABASE_PASSWORD must all be set.",
    );
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url, ssl: databaseSsl() });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
    console.log("migrations applied");
  } catch (error) {
    // process.exitCode rather than process.exit(): exit() tears the process down without waiting for stderr to drain.
    console.error("migration failed:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
