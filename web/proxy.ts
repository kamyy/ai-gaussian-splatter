// Session parsing for every route. The auth checks live on the resources
// themselves: Route Handlers call requireUser(), and the (authenticated)
// layout calls auth.protect().
//
// Must stay at web/'s root, beside app/. Next loads it from nowhere else and
// says nothing when it's misplaced — every handler calling auth() then throws
// "clerkMiddleware() was not run".
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
