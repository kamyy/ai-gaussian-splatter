import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Vitest doesn't read web/.env itself. Only TEST_DATABASE_URL is taken from it, so the dev DATABASE_* values never
// reach a test. A value already set in the shell, as CI's web job does, wins. Setting process.env here, before any
// worker starts, is what lets both globalSetup and the test files see it.
const envFile = `${import.meta.dirname}/.env`;
if (existsSync(envFile)) {
  const testDatabaseUrl = parseEnv(readFileSync(envFile, "utf8")).TEST_DATABASE_URL;
  if (testDatabaseUrl !== undefined) {
    process.env.TEST_DATABASE_URL ??= testDatabaseUrl;
  }
}

// Two projects: component tests need jsdom, while server-side code is plain
// Node — no DOM, and a real Postgres for the rate-limit and Route Handler tiers.
// Route Handlers live under app/api/, so those tests are routed to the server
// project explicitly and excluded from the client one.
export default defineConfig({
  test: {
    fileParallelism: false,
    projects: [
      {
        plugins: [react()],
        resolve: { alias: { "@": import.meta.dirname } },
        test: {
          name: "client",
          environment: "jsdom",
          setupFiles: ["./tests/jsdom-setup.ts"],
          include: ["app/**/*.test.{ts,tsx}", "components/**/*.test.{ts,tsx}", "lib/tests/*.test.ts"],
          exclude: ["node_modules", ".next", "e2e/**", "app/api/**"],
        },
      },
      {
        resolve: { alias: { "@": import.meta.dirname } },
        test: {
          name: "server",
          environment: "node",
          globalSetup: ["./tests/migrate-test-db.ts"],
          setupFiles: ["./tests/server-test-env.ts"],
          include: ["lib/server/**/*.test.ts", "app/api/**/*.test.ts"],
          exclude: ["node_modules", ".next", "e2e/**"],
        },
      },
    ],
  },
});
