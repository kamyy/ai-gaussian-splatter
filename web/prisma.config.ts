import { defineConfig, env } from "prisma/config";

// Prisma 7 moved the migration/introspection connection URL out of
// schema.prisma's `datasource` block and into this file. The runtime client
// gets its connection separately, via the driver adapter in lib/server/prisma.ts.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
