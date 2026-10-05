/**
 * Configuration for the Playwright end-to-end tests in web/e2e/.
 *
 * End-to-end tests drive a real browser against the running app. web/e2e/ has no specs yet. CI skips Playwright until
 * that directory has a file.
 *
 * Only one server starts: the app itself. There's no HTTP mock to set up, because the share and view pages read the
 * database in the same process during server rendering, so nothing they render can be intercepted over the network.
 * Covering them needs a seeded test database. See the E2E gap in AGENTS.md's State / what's next.
 */

import { defineConfig, devices } from "@playwright/test";

import { LOCAL_APP_ORIGIN } from "./lib/server/env";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: LOCAL_APP_ORIGIN,
    trace: "on-first-retry",
  },
  webServer: {
    // Not `pnpm dev`, which also starts the splat-pg container. CI runs its own Postgres on the same port.
    command: "pnpm exec next dev -p 3000",
    url: LOCAL_APP_ORIGIN,
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
