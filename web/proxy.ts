// Route protection for the authenticated (dashboard) route group.
//
// Named `proxy.ts` (not `middleware.ts`) — Next.js 16 renamed the file
// convention and exported function name from `middleware` to `proxy`
// (middleware.ts is deprecated as of v16.0.0; a `middleware-to-proxy`
// codemod exists). clerkMiddleware()'s returned handler is otherwise
// unchanged and works fine under the new name — see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
//
// MUST live at the project root, beside `app/` — not inside it. This file was
// previously at app/proxy.ts, where Next.js silently never loaded it, so
// clerkMiddleware() never ran. That went unnoticed while auth was enforced by
// the separate FastAPI backend verifying JWTs itself; once auth moved in here,
// every authenticated Route Handler 500'd with "clerkMiddleware() was not run".
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Page routes only. API routes are NOT listed here: each authenticated Route
// Handler calls auth() itself, so the public endpoints (gallery, public
// objects, healthz, and the token-authenticated worker callback) can't be
// swept into blanket protection by a broadened matcher.
const isProtectedRoute = createRouteMatcher(["/dashboard(.*)", "/objects(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
