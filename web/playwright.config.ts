import { defineConfig, devices } from "@playwright/test";

// The E2E tier runs on every PR — fast and free, unlike the
// real-pipeline integration tests, which stay manual/milestone-gated.
//
// Only one server is started, the app itself. There is no HTTP mock to stand
// up: the gallery and view pages read the database in-process during SSR, so
// nothing they render can be intercepted over the wire. Covering them needs a
// seeded test database, which is why the single spec in e2e/ is skipped —
// see e2e/gallery.spec.ts.
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
