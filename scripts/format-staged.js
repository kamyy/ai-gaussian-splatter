#!/usr/bin/env node
// Auto-formats/lints staged files and re-stages the result — the
// pre-commit auto-fix step for both JS/TS (via Biome) and Python (via
// ruff format), so a developer doesn't have to remember to run either by
// hand before committing. CI enforces the same thing as a hard check
// (scripts/lint.js's `biome lint .` and `ruff format --check`), since
// there's no "re-stage and continue" concept there.
//
// `biome check --write --staged` fixes the working tree but doesn't
// re-stage — unlike the old pretty-quick --staged, which did — so the
// fix is re-added explicitly below, the same way the Python half
// already did.
import { execFileSync } from "node:child_process";

execFileSync("npx", ["biome", "check", "--write", "--staged", "--no-errors-on-unmatched"], { stdio: "inherit" });

const stagedFiles = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

if (stagedFiles.length > 0) {
  execFileSync("git", ["add", ...stagedFiles], { stdio: "inherit" });
}

const PACKAGES = ["backend", "worker", "infra"];

for (const pkg of PACKAGES) {
  const prefix = `${pkg}/`;
  const relativePaths = stagedFiles
    .filter(f => f.startsWith(prefix) && f.endsWith(".py"))
    .map(f => f.slice(prefix.length));

  if (relativePaths.length === 0) continue;

  console.log(`\n> ${pkg}: uv run ruff format ${relativePaths.join(" ")}`);
  execFileSync("uv", ["run", "ruff", "format", ...relativePaths], { cwd: pkg, stdio: "inherit" });
  execFileSync("git", ["add", ...relativePaths.map(p => `${pkg}/${p}`)], { stdio: "inherit" });
}
