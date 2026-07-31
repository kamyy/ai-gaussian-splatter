// Route protection for the authenticated (dashboard) route group.
//
// Named `proxy.ts` (not `middleware.ts`) — Next.js 16 renamed the file
// convention and exported function name from `middleware` to `proxy`
// (middleware.ts is deprecated as of v16.0.0; a `middleware-to-proxy`
// codemod exists). clerkMiddleware()'s returned handler is otherwise
// unchanged and works fine under the new name — see
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtectedRoute = createRouteMatcher(["/dashboard(.*)", "/objects(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};
