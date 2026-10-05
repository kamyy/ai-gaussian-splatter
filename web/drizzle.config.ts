/**
 * Configuration for the drizzle-kit CLI, which generates database migrations.
 *
 * Used only by the drizzle-kit CLI (`db:generate` and `db:studio`). The running app gets its connection separately,
 * from the pg Pool in web/lib/server/db/index.ts, which takes discrete fields and re-fetches the RDS password for each
 * new connection instead of assembling a URL.
 *
 * `casing` is deliberately not set. Every column in web/lib/server/db/schema.ts states its database name explicitly, so
 * there is no naming rule that could drift between what drizzle-kit writes into a migration and what the running app
 * queries. See AGENTS.md.
 */

import { defineConfig } from "drizzle-kit";

import { databaseSsl, resolveDatabaseUrl } from "./lib/server/databaseUrl";
import { getEnv } from "./lib/server/env";

/**
 * An empty string rather than a throw when unset, because `drizzle-kit generate` only diffs the schema against the
 * checked-in snapshot and needs no database. Local dev always uses `splat-pg`, so the URL is unset only when NODE_ENV
 * is `production` or `test`.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: resolveDatabaseUrl(getEnv()) ?? "",
    // Dead while `url` is set, which it always is here, because drizzle-kit's CLI driver then ignores a sibling `ssl`
    // (AGENTS.md). `pnpm db:studio` against a TLS-only database therefore fails rather than connecting in plaintext.
    // `pnpm db:migrate` runs web/scripts/db-migrate.cjs, which builds its own pool.
    ssl: databaseSsl(),
  },
});
