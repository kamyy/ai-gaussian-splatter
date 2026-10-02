/**
 * Configuration for the Vitest unit and integration tests.
 *
 * Splits the tests into two projects: "client" runs component and browser-side tests in jsdom (a simulated browser),
 * and "server" runs Route Handler and database tests in plain Node against a real test Postgres.
 */

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Vitest leaves a NODE_ENV the shell already set alone. web/lib/server/env.ts treats anything but "production" or
// "test" as local dev and points the database at the dev one, where the tests would then clear tables. Forcing "test"
// keeps a stray NODE_ENV=development in the shell from doing that.
// Object.assign because Next's types declare NODE_ENV read-only.
Object.assign(process.env, { NODE_ENV: "test" });

// Tests run against the test database on the `splat-pg` container (scripts/dev/db.sh up). CI's web job starts its own
// Postgres with the same two databases. A value already set in the shell wins. Setting process.env here, before any
// worker starts, is what lets both globalSetup and the test files see it. Vitest doesn't read web/.env, so no dev
// setting reaches a test.
process.env.TEST_DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/ai_gaussian_splatter_test";

/**
 * Two projects: component tests need jsdom, while server-side code is plain Node with no DOM, plus a real Postgres for
 * the rate-limit and Route Handler tiers. Route Handlers live under app/api/, so those tests are routed to the server
 * project explicitly and excluded from the client one.
 */
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
          include: [
            "app/**/*.test.{ts,tsx}",
            "components/**/*.test.{ts,tsx}",
            "lib/tests/*.test.ts",
            "lib/hooks/tests/*.test.ts",
          ],
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
          include: ["lib/server/**/*.test.ts", "app/api/**/*.test.ts", "proxy.test.ts"],
          exclude: ["node_modules", ".next", "e2e/**"],
        },
      },
    ],
  },
});
