import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone with a self-contained server.js and only the traced runtime dependencies, so the container
  // doesn't ship node_modules. drizzle-orm and pg are both pure JS — there's no native binary or generated client for
  // file tracing to miss.
  output: "standalone",
  turbopack: {
    // web/ is an independent package with its own lockfile/node_modules, not part of a pnpm workspace — but the
    // root-level pnpm-lock.yaml (there for the repo's husky/Biome orchestration) makes Turbopack's multi-lockfile
    // heuristic infer the repo root instead. Pin it explicitly.
    root: __dirname,
  },
};

export default nextConfig;
