#!/usr/bin/env node
// Runs `tsc --noEmit` for web/ and `mypy` in each Python package,
// targeting source only (not tests, as a first pass). A small script
// instead of a shell `&&`/`cd` chain in package.json, so a failure in one
// package stops the run instead of letting subsequent `cd`s mask it.
//
// No root tsc --noEmit here — scripts/*.js is plain JS now, nothing under
// the repo root to typecheck.
import { execFileSync } from "node:child_process";

// web's own `typecheck` script runs `next typegen` first — see AGENTS.md for
// why that has to precede `tsc --noEmit` on a clean checkout.
execFileSync("pnpm", ["--dir", "web", "run", "typecheck"], { stdio: "inherit" });

const PACKAGES = [
  { dir: "worker", targets: ["pipeline"] },
  { dir: "infra", targets: ["app.py", "stacks"] },
];

for (const { dir, targets } of PACKAGES) {
  console.log(`\n> ${dir}: uv run mypy ${targets.join(" ")}`);
  execFileSync("uv", ["run", "mypy", ...targets], { cwd: dir, stdio: "inherit" });
}
