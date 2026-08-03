#!/usr/bin/env node
// Runs `tsc --noEmit` for both TS surfaces (root scripts/*.ts, frontend/)
// and `mypy` in each Python package, targeting source only (not tests, as
// a first pass). A small script instead of a shell `&&`/`cd` chain in
// package.json, so a failure in one package stops the run instead of
// letting subsequent `cd`s mask it.
import { execFileSync } from "node:child_process";

execFileSync("npx", ["tsc", "--noEmit"], { stdio: "inherit" });
execFileSync("pnpm", ["--dir", "frontend", "exec", "tsc", "--noEmit"], { stdio: "inherit" });

const PACKAGES: { dir: string; targets: string[] }[] = [
  { dir: "backend", targets: ["app"] },
  { dir: "worker", targets: ["pipeline"] },
  { dir: "infra", targets: ["app.py", "stacks"] },
];

for (const { dir, targets } of PACKAGES) {
  console.log(`\n> ${dir}: uv run mypy ${targets.join(" ")}`);
  execFileSync("uv", ["run", "mypy", ...targets], { cwd: dir, stdio: "inherit" });
}
