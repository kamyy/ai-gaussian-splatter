#!/usr/bin/env node
// Runs `biome lint .` (JS/TS across scripts/*.ts + frontend/) and `ruff
// check`/`ruff format --check` in each Python package. A small script
// instead of a shell `&&`/`cd` chain in package.json, so a failure in one
// package stops the run instead of letting subsequent `cd`s mask it.
import { execFileSync } from "node:child_process";

execFileSync("npx", ["biome", "lint", "."], { stdio: "inherit" });

const PACKAGES = ["backend", "worker", "infra"];

for (const pkg of PACKAGES) {
  // Linter: flags actual problems (unused imports, undefined names, etc.)
  // per [tool.ruff.lint] select in the package's pyproject.toml.
  console.log(`\n> ${pkg}: uv run ruff check .`);
  execFileSync("uv", ["run", "ruff", "check", "."], { cwd: pkg, stdio: "inherit" });
  // Formatter (Black-compatible), run in check-only mode: fails if a file
  // isn't already in canonical layout, without rewriting it. The staged
  // auto-fix equivalent (`ruff format`, no --check) runs in format-staged.ts.
  console.log(`\n> ${pkg}: uv run ruff format --check .`);
  execFileSync("uv", ["run", "ruff", "format", "--check", "."], { cwd: pkg, stdio: "inherit" });
}
