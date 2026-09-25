#!/usr/bin/env node
// Formats and lints the staged files, then stages the result again. This is the pre-commit auto-fix step for both JS/TS
// (Biome) and Python (ruff format), so nobody has to remember to run either by hand before committing. CI enforces the
// same thing as a hard check (`biome:ci` and `worker:check`'s `ruff format --check`), since CI can't fix files and
// carry on.
//
// Only files the formatters actually changed are staged again, found by comparing file hashes before and after. Running
// `git add` on every originally staged file would also stage any other unstaged edit in that file, such as the rest of
// a deliberate `git add -p`, silently pulling unrelated changes into the commit.
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

const workerPy = stagedFiles
  .filter(f => f.startsWith("worker/") && f.endsWith(".py"))
  .map(f => f.slice("worker/".length));

if (workerPy.length > 0) {
  console.log(`\n> worker: uv run ruff format ${workerPy.join(" ")}`);
  execFileSync("uv", ["run", "ruff", "format", ...workerPy], { cwd: "worker", stdio: "inherit" });
}

const after = hashFiles(stagedFiles);
const changed = stagedFiles.filter(f => before.get(f) !== after.get(f));

if (changed.length > 0) {
  execFileSync("git", ["add", ...changed], { stdio: "inherit" });
}
