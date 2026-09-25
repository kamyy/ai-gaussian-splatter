import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
