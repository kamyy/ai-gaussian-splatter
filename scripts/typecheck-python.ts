#!/usr/bin/env node
// Runs `mypy` in each Python package, targeting source only (not tests, as
// a first pass). A small script instead of a shell `&&`/`cd` chain in
// package.json, so a failure in one package stops the run instead of
// letting subsequent `cd`s mask it.
import { execFileSync } from "node:child_process";

const PACKAGES: { dir: string; targets: string[] }[] = [
  { dir: "backend", targets: ["app"] },
  { dir: "worker", targets: ["pipeline"] },
  { dir: "infra", targets: ["app.py", "stacks"] },
];

for (const { dir, targets } of PACKAGES) {
  console.log(`\n> ${dir}: uv run mypy ${targets.join(" ")}`);
  execFileSync("uv", ["run", "mypy", ...targets], { cwd: dir, stdio: "inherit" });
}
