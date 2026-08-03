import { defineConfig, devices } from "@playwright/test";

// Plan §8: the E2E tier runs against a mocked backend, not a real GPU job —
// fast and free to run on every PR, unlike the real-pipeline integration
// tests which stay manual/milestone-gated.
//
// STALE — see the skipped test in e2e/gallery.spec.ts. The gallery/view pages
// read Prisma in-process, so nothing requests the mock server below and
// NEXT_PUBLIC_API_BASE_URL is dead (lib/api.ts is same-origin). Replacing both
// with a seeded test database is deferred work.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: "node e2e/mock-backend.mjs",
      url: "http://localhost:8000/api/v1/gallery",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "pnpm dev",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env.CI,
      env: { NEXT_PUBLIC_API_BASE_URL: "http://localhost:8000" },
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
