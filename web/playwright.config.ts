import { defineConfig, devices } from "@playwright/test";

// Plan §8: the E2E tier runs against a mocked backend, not a real GPU job —
// fast and free to run on every PR, unlike the real-pipeline integration
// tests which stay manual/milestone-gated.
//
// STALE as of 2026-08-03 — see the skipped test in e2e/gallery.spec.ts.
// The mock backend below exists because the gallery/view pages used to fetch a
// separate FastAPI service during SSR, which browser-level interception
// (page.route(), MSW's service worker) cannot see. Those pages now read Prisma
// in-process, so nothing requests this server at all. Replacing it with a
// seeded test database is deferred work; until then this config keeps a server
// running that serves no one, and NEXT_PUBLIC_API_BASE_URL below is dead
// (lib/api.ts is same-origin now).
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
