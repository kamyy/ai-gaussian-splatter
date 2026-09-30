/**
 * Runs Clerk's middleware ahead of every page and API route.
 *
 * Next.js runs the function this file exports as `proxy` before each matching request. clerkMiddleware() reads the Clerk session
 * cookie, so later code can tell who is signed in. It doesn't block anyone itself: pages and API routes check sign-in
 * on their own. The matcher is the list of URL patterns it runs for. It skips static files by extension.
 */

import { clerkMiddleware } from "@clerk/nextjs/server";

export const proxy = clerkMiddleware();
export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
    // Always run for Clerk-specific frontend API routes
    "/__clerk/(.*)",
  ],
};
