#!/usr/bin/env node
// Runs `tsc --noEmit` for web/ and `mypy` in each Python package,
// targeting source only (not tests, as a first pass). A small script
// instead of a shell `&&`/`cd` chain in package.json, so a failure in one
// package stops the run instead of letting subsequent `cd`s mask it.
//
// No root tsc --noEmit here — scripts/*.js is plain JS now, nothing under
// the repo root to typecheck.
import { execFileSync } from "node:child_process";

// App Router types (including global `RouteContext<"/path">`, which our Route
// Handlers use for typed `params`) are normally written to web/.next/types/ by
// `next dev` / `next build`. That dir is gitignored, so on a clean clone those
// commands haven't run yet and plain `tsc --noEmit` fails with "Cannot find
// name 'RouteContext'". `next typegen` exists to emit those types without
// starting the app or doing a full build — run it first.
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
