import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run on every PR, since they're fast and free. The tests that run the real pipeline cost GPU money,
// so they stay manual.
//
// Only one server starts: the app itself. There's no HTTP mock to set up, because the share and view pages read the
// database in the same process during SSR, so nothing they render can be intercepted over the network. Covering them
// needs a seeded test database. See the E2E gap in AGENTS.md's State / what's next.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
