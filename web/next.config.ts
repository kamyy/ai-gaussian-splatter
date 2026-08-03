import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // frontend/ is an independent package with its own lockfile/node_modules,
    // not part of a pnpm workspace — but the root-level pnpm-lock.yaml (added
    // for the repo's husky/prettier orchestration) makes Turbopack's
    // multi-lockfile heuristic infer the repo root instead. Pin it explicitly.
    root: __dirname,
  },
};

export default nextConfig;
