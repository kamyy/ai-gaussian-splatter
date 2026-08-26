import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

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
          setupFiles: ["./test/jsdom-setup.ts"],
          include: ["app/**/*.test.{ts,tsx}", "components/**/*.test.{ts,tsx}", "lib/*.test.ts"],
          exclude: ["node_modules", ".next", "e2e/**", "app/api/**"],
        },
      },
      {
        resolve: { alias: { "@": import.meta.dirname } },
        test: {
          name: "server",
          environment: "node",
          globalSetup: ["./test/migrate-test-db.ts"],
          setupFiles: ["./test/server-test-env.ts"],
          include: ["lib/server/**/*.test.ts", "app/api/**/*.test.ts"],
          exclude: ["node_modules", ".next", "e2e/**"],
        },
      },
    ],
  },
});
