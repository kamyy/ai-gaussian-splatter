#!/usr/bin/env node
// Runs `ruff check` in each Python package. A small script instead of a
// shell `&&`/`cd` chain in package.json, so a failure in one package stops
// the run instead of letting subsequent `cd`s mask it.
import { execFileSync } from "node:child_process";

const PACKAGES = ["backend", "worker", "infra"];

for (const pkg of PACKAGES) {
  console.log(`\n> ${pkg}: uv run ruff check .`);
  execFileSync("uv", ["run", "ruff", "check", "."], { cwd: pkg, stdio: "inherit" });
}
