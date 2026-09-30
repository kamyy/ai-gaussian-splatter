import { afterEach, describe, expect, it, vi } from "vitest";

// getEnv() caches its parse in a module-level variable, so each case re-imports web/lib/server/env.ts after resetting
// the registry. web/tests/server-test-env.ts has already filled process.env with values that parse.
async function loadGetEnv() {
  vi.resetModules();
  const { getEnv } = await import("../env");

  return getEnv;
}

describe("getEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("parses the environment the tests run with", async () => {
    const getEnv = await loadGetEnv();

    expect(getEnv().AWS_REGION).toBe(process.env.AWS_REGION);
  });

  // AWS_REGION carries no default on purpose: a default would sign against the region it names rather than the one a
  // moved deploy is in. The two cases below are the two shapes that reaches getEnv() as. Each message is matched whole
  // so it pins which field failed and why, rather than passing on any error that happens to name AWS_REGION.
  it("rejects an unset AWS_REGION instead of falling back to a default", async () => {
    vi.stubEnv("AWS_REGION", undefined);

    // stubEnv removes the key rather than assigning it, so this is the same state as delete process.env.AWS_REGION.
    expect("AWS_REGION" in process.env).toBe(false);
    const getEnv = await loadGetEnv();

    expect(() => getEnv()).toThrow(
      /^Invalid server environment: AWS_REGION: Invalid input: expected string, received undefined$/,
    );
  });

  // What an unset GitHub repository variable sends, and what a blank AWS_REGION= line in web/.env parses to.
  it("rejects an empty AWS_REGION", async () => {
    vi.stubEnv("AWS_REGION", "");
    const getEnv = await loadGetEnv();

    expect(() => getEnv()).toThrow(
      /^Invalid server environment: AWS_REGION: Too small: expected string to have >=1 characters$/,
    );
  });

  // Local dev runs the worker under Podman, which reads none of the EC2 launch settings, so web/.env leaves them out.
  it("accepts a missing EC2 launch setting when the worker launches locally", async () => {
    vi.stubEnv("WORKER_LOCAL_LAUNCH", "true");
    vi.stubEnv("WORKER_AMI_ID", undefined);
    vi.stubEnv("WORKER_LOG_GROUP", undefined);
    const getEnv = await loadGetEnv();

    expect(getEnv().WORKER_AMI_ID).toBeUndefined();
  });

  // The ECS task has no WORKER_LOCAL_LAUNCH, so a dropped WORKER_* variable has to fail here rather than at the first
  // worker launch.
  it.each([
    "WORKER_AMI_ID",
    "WORKER_SUBNET_ID",
    "WORKER_SECURITY_GROUP_ID",
    "WORKER_INSTANCE_PROFILE_ARN",
    "WORKER_LOG_GROUP",
  ])("rejects an unset %s when the worker launches on EC2", async name => {
    vi.stubEnv("WORKER_LOCAL_LAUNCH", undefined);
    vi.stubEnv(name, undefined);
    const getEnv = await loadGetEnv();

    expect(() => getEnv()).toThrow(`Invalid server environment: ${name}: required unless WORKER_LOCAL_LAUNCH is true`);
  });
});
