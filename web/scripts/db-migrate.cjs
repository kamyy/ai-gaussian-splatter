// Applies the migrations in web/drizzle/ — used by `pnpm db:migrate` everywhere: local dev, ci.yml, and the migrator
// image's CMD (web/Dockerfile).
//
// Not `drizzle-kit migrate` because it can exit 1 without printing any error. drizzle-team/drizzle-orm#5521. Delete
// this script and point db:migrate back at `drizzle-kit migrate` once the fix ships in a stable release.
//
// CommonJS keeps Node from reparsing databaseUrl.ts as a module of unknown type, which warns on every run.
const path = require("node:path");
const { loadEnvConfig } = require("@next/env");
const { drizzle } = require("drizzle-orm/node-postgres");
const { migrate } = require("drizzle-orm/node-postgres/migrator");
const { Pool } = require("pg");

const { databaseSsl, resolveDatabaseUrl } = require("../lib/server/databaseUrl.ts");

// Locally, __dirname is web/scripts/, so this resolves to web/drizzle/. In the migrator image, __dirname is
// /app/scripts/, so this resolves to /app/drizzle/.
const migrationsFolder = path.join(__dirname, "..", "drizzle");

// Loads web/.env the same way `next dev`/`next build` do, so a `pnpm db:migrate` can pick up local config. No-op in CI
// and the migrator image: neither ships a .env file (.dockerignore excludes it), so this falls through to whatever the
// job/task already set in process.env.
loadEnvConfig(path.join(__dirname, ".."));

async function main() {
  const url = resolveDatabaseUrl();
  if (url === undefined) {
    console.error(
      "No database configured: DATABASE_HOST, DATABASE_NAME, DATABASE_USER and DATABASE_PASSWORD must all be set.",
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
