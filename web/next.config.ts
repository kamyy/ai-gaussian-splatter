/**
 * Next.js build configuration.
 *
 * Builds the app as a standalone server for the production container, pins the project root for Turbopack, Next's
 * bundler, and sets the security headers every response carries.
 */

import type { NextConfig } from "next";

// web/proxy.ts sets the Content Security Policy, which needs runtime values. These are the same for every response.
const SECURITY_HEADERS = [
  // Browsers that have seen this once refuse plain HTTP to this host for two years, so a network attacker can't strip
  // TLS on a later visit. Browsers ignore it on a plain-HTTP response, so local dev is unaffected.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // Stops a browser from guessing a response is HTML or script when its Content-Type says otherwise.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // The CSP's frame-ancestors covers current browsers. This covers older ones.
  { key: "X-Frame-Options", value: "DENY" },
  // A splat id in a page's URL never reaches another site in the Referer header.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // Emits .next/standalone with a self-contained server.js and only the runtime dependencies file tracing finds, so the
  // container doesn't ship all of node_modules. drizzle-orm and pg are both pure JavaScript, so there's no native
  // binary or generated client for file tracing to miss.
  output: "standalone",
  turbopack: {
    // web/ is an independent package with its own lockfile and node_modules, not part of a pnpm workspace. The
    // root-level pnpm-lock.yaml (for the repo's husky and Biome tooling) makes Turbopack guess the repo root as the
    // project root instead, so it is pinned here explicitly.
    root: __dirname,
  },
};

export default nextConfig;
