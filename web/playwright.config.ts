import { defineConfig, devices } from "@playwright/test";

// Plan §8: the E2E tier runs against a mocked backend, not a real GPU job —
// fast and free to run on every PR, unlike the real-pipeline integration
// tests which stay manual/milestone-gated.
//
// Two webServer entries: the mock backend (e2e/mock-backend.mjs) and the
// Next.js dev server pointed at it. Browser-level route mocking (MSW's
// service worker, or page.route()) can't be used for the gallery/view pages
// specifically, since they fetch server-side during Next's SSR (force-dynamic
// per app/gallery/page.tsx) — that's a request from the Node.js server
// process, invisible to browser-level interception. A real (if tiny) HTTP
// server is the correct fix for that case; MSW's browser worker remains the
// right tool for mocking fetches made by client components.
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
