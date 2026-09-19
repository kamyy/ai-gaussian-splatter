import { defineConfig } from "drizzle-kit";

import { databaseSsl, resolveDatabaseUrl } from "./lib/server/databaseUrl";

// Used by the drizzle-kit CLI only (generate/migrate/studio). The runtime gets its connection separately, from the pg
// Pool in web/lib/server/db/index.ts, which takes discrete fields and re-fetches the RDS password per connection
// instead of assembling a URL.
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
    // Only `pnpm db:studio` reads this. drizzle-kit's CLI driver ignores a sibling `ssl` whenever `url` is also set
    // (AGENTS.md), and `pnpm db:migrate` runs web/scripts/db-migrate.cjs, which builds its own pool.
    ssl: databaseSsl(),
  },
});
