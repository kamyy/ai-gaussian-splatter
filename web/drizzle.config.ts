import { defineConfig } from "drizzle-kit";

import { databaseSsl, resolveDatabaseUrl } from "./lib/server/databaseUrl";

// Used only by the drizzle-kit CLI (generate, migrate, studio). The running app gets its connection separately, from
// the pg Pool in web/lib/server/db/index.ts, which takes discrete fields and re-fetches the RDS password for each new
// connection instead of assembling a URL.
//
// `casing` is deliberately not set. Every column in web/lib/server/db/schema.ts states its database name explicitly, so
// there is no naming rule that could drift between what drizzle-kit writes into a migration and what the running app
// queries. See AGENTS.md.
//
// An empty string rather than a throw when unset, because `drizzle-kit generate` only diffs the schema against the
// checked-in snapshot and needs no database.
export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: resolveDatabaseUrl() ?? "",
    // Only `pnpm db:studio` reads this. drizzle-kit's CLI driver ignores a sibling `ssl` whenever `url` is also set
    // (AGENTS.md), and `pnpm db:migrate` runs web/scripts/db-migrate.cjs, which builds its own pool.
    ssl: databaseSsl(),
  },
});
