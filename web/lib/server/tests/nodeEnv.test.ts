import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// isLocalDevEnv() (web/lib/server/env.ts) treats any NODE_ENV but "production" or "test" as local dev. That turns
// on the localhost database defaults and the Podman worker launch, and turns off the WORKER_* checks. A shipped image
// that lost its NODE_ENV=production would run like that, so each one is pinned here.
const dockerfile = readFileSync(`${import.meta.dirname}/../../../Dockerfile`, "utf8");

function stage(name: string): string {
  const start = dockerfile.indexOf(`AS ${name}\n`);
  const next = dockerfile.indexOf("\nFROM ", start);

  return dockerfile.slice(start, next === -1 ? undefined : next);
}

describe("web/Dockerfile", () => {
  it.each(["migrator", "web"])("sets NODE_ENV=production in the shipped %s stage", name => {
    expect(stage(name)).toMatch(/^ENV NODE_ENV=production$/m);
  });
});
