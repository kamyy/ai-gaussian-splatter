import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone with a self-contained server.js and only the
  // traced runtime dependencies, so the container doesn't ship node_modules.
  // Works cleanly with Prisma 7 specifically because its driver adapters are
  // pure JS — there's no query-engine binary for file tracing to miss.
  output: "standalone",
  turbopack: {
    // frontend/ is an independent package with its own lockfile/node_modules,
    // not part of a pnpm workspace — but the root-level pnpm-lock.yaml (added
    // for the repo's husky/prettier orchestration) makes Turbopack's
    // multi-lockfile heuristic infer the repo root instead. Pin it explicitly.
    root: __dirname,
  },
};

export default nextConfig;
