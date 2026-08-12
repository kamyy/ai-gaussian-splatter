import { expect, test } from "@playwright/test";

// Public-path E2E: no auth needed, so no Clerk test-mode setup required —
// this is the piece of the golden path reachable here.
//
// The full authenticated golden path (sign in -> upload -> trigger -> poll
// -> view, per plan §8) needs Clerk's `@clerk/testing` package with real
// Clerk test-mode API keys to bypass interactive sign-in, not configured in
// this sandbox — see plan M6/M7.

const GALLERY_ITEM_ID = "11111111-1111-1111-1111-111111111111";

// SKIPPED: a real gap, not a flake. app/gallery/page.tsx queries the database
// directly during SSR, so with no data seeded the page renders empty — and
// browser-level route mocking cannot reach a query made in Next's server
// process.
//
// Fix: seed the gallery row into a real test database and point the dev
// server at it — a deferred harness redesign. Un-skip as part of that work;
// don't fix this by asserting against an empty page.
test.skip("gallery page lists items and links to detail pages with real OG data", async ({ page }) => {
  await page.goto("/gallery");

  await expect(page.getByRole("heading", { name: "Gallery" })).toBeVisible();
  await expect(page.getByText("Ceramic mug")).toBeVisible();

  await page.getByText("Ceramic mug").click();
  await expect(page).toHaveURL(new RegExp(`/gallery/${GALLERY_ITEM_ID}`));
  await expect(page.getByRole("heading", { name: "Ceramic mug" })).toBeVisible();

  // Verifies the OG tags generateMetadata produces server-side — the whole
  // reason Next.js was chosen over the original Vite plan (see plan Context).
  const ogTitle = await page.locator('meta[property="og:title"]').getAttribute("content");
  expect(ogTitle).toBe("Ceramic mug");
});
