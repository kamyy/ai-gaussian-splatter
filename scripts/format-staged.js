#!/usr/bin/env node
// Auto-formats/lints staged files and re-stages the result — the pre-commit auto-fix step for both JS/TS (via Biome)
// and Python (via ruff format), so a developer doesn't have to remember to run either by hand before committing. CI
// enforces the same thing as a hard check (scripts/lint.js's `biome lint .` and `ruff format --check`), since there's
// no "re-stage and continue" concept there.
//
// Re-stages only files the formatters actually changed, by comparing working tree content hashes before and after: `git
// add <every originally staged file>` would also re-stage any other unstaged edit already sitting in that file's
// working tree (e.g. a deliberate partial `git add -p` stage), silently pulling unrelated changes into the commit.
import { execFileSync } from "node:child_process";

function hashFiles(files) {
  if (files.length === 0) {
    return new Map();
  }
  const hashes = execFileSync("git", ["hash-object", ...files], { encoding: "utf8" })
    .trim()
    .split("\n");
  return new Map(files.map((file, i) => [file, hashes[i]]));
}

const stagedFiles = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

const before = hashFiles(stagedFiles);

execFileSync("npx", ["biome", "check", "--write", "--staged", "--no-errors-on-unmatched"], { stdio: "inherit" });

const PACKAGES = ["worker", "infra"];

for (const pkg of PACKAGES) {
  const prefix = `${pkg}/`;
  const relativePaths = stagedFiles
    .filter(f => f.startsWith(prefix) && f.endsWith(".py"))
    .map(f => f.slice(prefix.length));

  if (relativePaths.length === 0) {
    continue;
  }

  console.log(`\n> ${pkg}: uv run ruff format ${relativePaths.join(" ")}`);
  execFileSync("uv", ["run", "ruff", "format", ...relativePaths], { cwd: pkg, stdio: "inherit" });
}

const after = hashFiles(stagedFiles);
const changed = stagedFiles.filter(f => before.get(f) !== after.get(f));

if (changed.length > 0) {
  execFileSync("git", ["add", ...changed], { stdio: "inherit" });
}
