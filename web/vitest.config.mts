import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Two projects: component tests need jsdom, while lib/server/** is plain Node —
// no DOM, and a real Postgres for the rate-limit tier.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: { alias: { "@": import.meta.dirname } },
        test: {
          name: "client",
          environment: "jsdom",
          setupFiles: ["./test/setup.ts"],
          include: ["app/**/*.test.{ts,tsx}", "components/**/*.test.{ts,tsx}", "lib/*.test.ts"],
          exclude: ["node_modules", ".next", "e2e/**"],
        },
      },
      {
        resolve: { alias: { "@": import.meta.dirname } },
        test: {
          name: "server",
          environment: "node",
          globalSetup: ["./test/server-global-setup.ts"],
          setupFiles: ["./test/server-setup.ts"],
          include: ["lib/server/**/*.test.ts"],
          exclude: ["node_modules", ".next", "e2e/**"],
        },
      },
    ],
  },
});
