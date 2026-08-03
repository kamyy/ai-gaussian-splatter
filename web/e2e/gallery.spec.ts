import { expect, test } from "@playwright/test";

// Public-path E2E: no auth needed, so no Clerk test-mode setup required —
// this is the piece of the golden path we can actually run here. Data comes
// from the real mock backend server (e2e/mock-backend.mjs), not browser-level
// route mocking — see playwright.config.ts for why.
//
// The full authenticated golden path (sign in -> upload -> trigger -> poll
// -> view, per plan §8) additionally needs Clerk's `@clerk/testing` package
// with real Clerk test-mode API keys to bypass interactive sign-in, which
// this sandbox doesn't have configured. That's the next piece to add here,
// not something to fake — see plan M6/M7.

const GALLERY_ITEM_ID = "11111111-1111-1111-1111-111111111111";

// SKIPPED, and it is a real gap rather than a flake.
//
// app/gallery/page.tsx reads Prisma directly, so e2e/mock-backend.mjs serves
// data nothing requests and the page renders empty.
//
// The fix is to seed the gallery row into a real test database and point the
// dev server at it, deleting mock-backend.mjs entirely — a harness redesign
// deliberately deferred out of the consolidation. Un-skip as part of that work;
// do not "fix" it by asserting against an empty page.
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
