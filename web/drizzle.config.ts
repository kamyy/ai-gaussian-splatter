import { defineConfig } from "drizzle-kit";

import { databaseSsl, resolveDatabaseUrl } from "./lib/server/databaseUrl";

// Used by the drizzle-kit CLI only (generate/migrate/studio). The runtime gets its connection separately, from the pg
// Pool in web/lib/server/db/index.ts. Both resolve the URL the same way, so applying migrations against a deployed
// database works with the same variables the running task already has.
//
// `casing` is deliberately not set: every column in schema.ts carries its database name explicitly, so there is no
// derivation rule that could drift between what drizzle-kit emits into a migration and what the running app queries.
// See AGENTS.md.
//
// Empty string rather than a throw when unset: `drizzle-kit generate` diffs the schema against the checked-in snapshot
// and needs no database at all.
export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: resolveDatabaseUrl() ?? "",
    // Same TLS treatment as the running app — `drizzle-kit migrate` against a deployed database hits the same
    // rds.force_ssl requirement.
    ssl: databaseSsl(),
  },
});
