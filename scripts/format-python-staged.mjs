#!/usr/bin/env node
// Auto-formats staged Python files with `ruff format` and re-stages them —
// the Python equivalent of pretty-quick's staged-file auto-fix, so a
// developer doesn't have to remember to run `ruff format` by hand before
// committing. CI enforces the same thing as a hard check (see
// scripts/lint-python.mjs's `ruff format --check`), since there's no
// "re-stage and continue" concept there.
import { execFileSync } from "node:child_process";

const PACKAGES = ["backend", "worker", "infra"];

const stagedFiles = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

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
