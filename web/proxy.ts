/**
 * Runs Clerk's middleware ahead of every page and API route, and sets the Content Security Policy.
 *
 * Next.js runs the function this file exports as `proxy` before each matching request. clerkMiddleware() reads the Clerk session
 * cookie, so later code can tell who is signed in. It doesn't block anyone itself: pages and API routes check sign-in
 * on their own. The matcher is the list of URL patterns it runs for. It skips static files by extension.
 *
 * The Content Security Policy (CSP) tells the browser which origins a page may load scripts, styles, images and
 * connections from. It is built here rather than in web/next.config.ts because it names the S3 buckets, which are only
 * known at runtime. The other security headers don't vary, so web/next.config.ts sets them.
 */

import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

import { getEnv } from "@/lib/server/env";

/**
 * The origin of Clerk's Frontend API, which serves Clerk's browser script and answers its requests. The publishable key
 * is that host name, base64-encoded and followed by "$", after the pk_test_ or pk_live_ prefix.
 */
function clerkFrontendApi(): string {
  const encoded = (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "").split("_")[2] ?? "";

  return `https://${atob(encoded).replace(/\$$/, "")}`;
}

/**
 * The CSP for every page. Exported for its tests.
 *
 * script-src allows inline scripts, which next-themes' pre-hydration script and Google Analytics both are. A nonce
 * would force every page to render per request. The policy still limits scripts to these origins. 'wasm-unsafe-eval'
 * lets the splat viewer (@sparkjsdev/spark) compile its WebAssembly. Development also needs 'unsafe-eval', because
 * React uses eval there to rebuild server error stacks.
 */
export function contentSecurityPolicy(): string {
  const env = getEnv();
  const buckets = [env.UPLOADS_BUCKET, env.SPLATS_BUCKET].map(
    bucket => `https://${bucket}.s3.${env.AWS_REGION}.amazonaws.com`,
  );
  const clerk = clerkFrontendApi();
  // Google's documented sources for Google Analytics 4. Its scripts and requests can come from any subdomain of these.
  const googleAnalytics = ["https://*.google-analytics.com", "https://*.analytics.google.com"];
  const googleTagManager = "https://*.googletagmanager.com";
  const devEval = process.env.NODE_ENV === "development" ? ["'unsafe-eval'"] : [];

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      "'unsafe-inline'",
      "'wasm-unsafe-eval'",
      ...devEval,
      clerk,
      "https://challenges.cloudflare.com",
      googleTagManager,
    ],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "blob:", "data:", "https://img.clerk.com", ...buckets, ...googleAnalytics, googleTagManager],
    "font-src": ["'self'"],
    "connect-src": ["'self'", clerk, ...buckets, ...googleAnalytics, googleTagManager],
    "worker-src": ["'self'", "blob:"],
    // Clerk's bot protection runs Cloudflare Turnstile in an iframe on the sign-up page.
    "frame-src": ["https://challenges.cloudflare.com"],
    "frame-ancestors": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
  };

  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}

export const proxy = clerkMiddleware(() => {
  const response = NextResponse.next();
  response.headers.set("Content-Security-Policy", contentSecurityPolicy());

  return response;
});

export const config = {
  matcher: [
    // This pattern skips Next.js internals and static files, unless the extension is only in the search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // This pattern always runs for API routes.
    "/(api|trpc)(.*)",
    // This pattern always runs for Clerk's frontend API routes.
    "/__clerk/(.*)",
  ],
};
