// Route protection for the (authenticated) route group.
//
// Named `proxy.ts`, not `middleware.ts`: Next.js 16 renamed the file
// convention and exported function to `proxy`. clerkMiddleware()'s handler
// works unchanged under the new name — see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
//
// Must live at the project root, beside `app/`, not inside it — Next loads it
// from nowhere else, and every handler calling auth() then throws
// "clerkMiddleware() was not run". `next build` listing "Proxy (Middleware)"
// confirms it's wired up.
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Page routes only. API routes still run through the proxy (config.matcher
// below) so auth() can read the session, but each authenticated handler calls
// auth() itself — protecting /api here would lock out the public endpoints and
// the worker's token-authenticated callback.
const isProtectedRoute = createRouteMatcher(["/dashboard(.*)", "/objects(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
