import { defineConfig } from "drizzle-kit";

// Used by the drizzle-kit CLI only (generate/migrate/studio). The runtime gets
// its connection separately, from the pg Pool in lib/server/db/index.ts.
//
// `casing` is deliberately not set: every column in schema.ts carries its
// database name explicitly, so there is no derivation rule that could drift
// between what drizzle-kit emits into a migration and what the running app
// queries. See AGENTS.md.
export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
