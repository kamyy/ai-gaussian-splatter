#!/usr/bin/env node
// Runs `tsc --noEmit` for web/ and `mypy` in each Python package,
// targeting source only (not tests, as a first pass). A small script
// instead of a shell `&&`/`cd` chain in package.json, so a failure in one
// package stops the run instead of letting subsequent `cd`s mask it.
//
// No root tsc --noEmit here — scripts/*.js is plain JS now, nothing under
// the repo root to typecheck.
import { execFileSync } from "node:child_process";

// `next typegen` first: the API Route Handlers reference `RouteContext<"...">`,
// a global type Next.js generates into web/.next/types/ (gitignored). Without
// this, tsc fails on a clean checkout with "Cannot find name 'RouteContext'".
execFileSync("pnpm", ["--dir", "web", "exec", "next", "typegen"], { stdio: "inherit" });
execFileSync("pnpm", ["--dir", "web", "exec", "tsc", "--noEmit"], { stdio: "inherit" });

const PACKAGES = [
  { dir: "worker", targets: ["pipeline"] },
  { dir: "infra", targets: ["app.py", "stacks"] },
];

for (const { dir, targets } of PACKAGES) {
  console.log(`\n> ${dir}: uv run mypy ${targets.join(" ")}`);
  execFileSync("uv", ["run", "mypy", ...targets], { cwd: dir, stdio: "inherit" });
}
