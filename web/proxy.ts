// Session parsing for every route. Auth checks live on the resources
// themselves, not here.
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
import { clerkMiddleware } from "@clerk/nextjs/server";

export default clerkMiddleware();

// Clerk's recommended matcher. Excluding static assets by file extension
// rather than by "contains a dot" is load-bearing: a page route can contain a
// dot too (/objects/my.splat.v2), and skipping the proxy for it means auth()
// throws inside the (authenticated) layout instead of redirecting to sign-in.
//
// Covers /api deliberately: clerkMiddleware() doesn't only block, it parses the
// session and attaches the context auth() reads inside a Route Handler. Drop
// `/(api|trpc)(.*)` and every authenticated handler throws.
export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
