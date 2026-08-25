#!/usr/bin/env node
// Pre-commit guard: infra/cdk.context.json is checked in so `cdk synth` works offline for the placeholder account (see
// CLAUDE.md). It should never gain an entry for a real AWS account — that only happens locally when AWS_ACCOUNT_ID is
// deliberately set to a real account for a manual deploy, and that entry should be reverted before committing, not
// shipped.
import { execFileSync } from "node:child_process";

const PLACEHOLDER_ACCOUNT = "123456789012";
const FILE = "infra/cdk.context.json";

let staged;
try {
  staged = execFileSync("git", ["show", `:${FILE}`], { encoding: "utf8" });
} catch {
  process.exit(0); // file isn't staged/tracked yet — nothing to guard
}

const context = JSON.parse(staged);
const badKeys = Object.keys(context).filter(key => {
  const match = key.match(/account=(\d+)/);
  return match && match[1] !== PLACEHOLDER_ACCOUNT;
});

if (badKeys.length > 0) {
  console.error(`\ncommit blocked: ${FILE} has a non-placeholder AWS account ID cached in:`);
  for (const key of badKeys) {
    console.error(`  ${key}`);
  }
  console.error(
    `\nThis repo is public — ${FILE} should only ever cache the placeholder account (${PLACEHOLDER_ACCOUNT}).`,
  );
  console.error(`Fix: git restore --staged ${FILE} && git checkout -- ${FILE}\n`);
  process.exit(1);
}
