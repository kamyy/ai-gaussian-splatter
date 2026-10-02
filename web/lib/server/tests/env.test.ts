import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveDatabaseUrl } from "../databaseUrl";
import { isLocalDev, LOCAL_APP_ORIGIN, withLocalDevEnv } from "../env";

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
  it("accepts a missing EC2 launch setting in local dev", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("WORKER_AMI_ID", undefined);
    vi.stubEnv("WORKER_LOG_GROUP", undefined);
    const getEnv = await loadGetEnv();

    expect(getEnv().WORKER_AMI_ID).toBeUndefined();
  });

  // The ECS task is not local dev, so a dropped WORKER_* variable has to fail here rather than at the first worker
  // launch.
  it.each([
    "WORKER_AMI_ID",
    "WORKER_SUBNET_ID",
    "WORKER_SECURITY_GROUP_ID",
    "WORKER_INSTANCE_PROFILE_ARN",
    "WORKER_LOG_GROUP",
    "WORKER_DATA_ROLE_ARN",
  ])("rejects an unset %s outside local dev", async name => {
    vi.stubEnv(name, undefined);
    const getEnv = await loadGetEnv();

    expect(() => getEnv()).toThrow(`Invalid server environment: ${name}: required outside local dev`);
  });

  // `pnpm dev` runs with NODE_ENV=development, and web/.env leaves out the settings that never change there.
  describe("in local dev", () => {
    function stubLocalDev() {
      vi.stubEnv("NODE_ENV", "development");
      for (const name of [
        "DATABASE_HOST",
        "DATABASE_PORT",
        "DATABASE_NAME",
        "DATABASE_USER",
        "DATABASE_PASSWORD",
        "APP_ORIGIN",
        "WORKER_AMI_ID",
      ]) {
        vi.stubEnv(name, undefined);
      }
    }

    // Without static keys the AWS SDK falls back to ~/.aws/credentials, which could name any IAM user.
    it.each(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"])("rejects an unset %s", async name => {
      stubLocalDev();
      vi.stubEnv(name, undefined);
      const getEnv = await loadGetEnv();

      expect(() => getEnv()).toThrow(`${name}: required in local dev, so the SDK can't use ~/.aws/credentials`);
    });

    // What an unedited web/.env copied from web/.env.example holds.
    it.each([
      ["AWS_ACCESS_KEY_ID", "replace-with-dev-user-key"],
      ["AWS_SECRET_ACCESS_KEY", "replace-with-dev-user-secret"],
    ])("rejects the placeholder %s", async (name, placeholder) => {
      stubLocalDev();
      vi.stubEnv(name, placeholder);
      const getEnv = await loadGetEnv();

      expect(() => getEnv()).toThrow(`${name}: still the placeholder from web/.env.example`);
    });

    it("rejects an empty AWS_ACCESS_KEY_ID", async () => {
      stubLocalDev();
      vi.stubEnv("AWS_ACCESS_KEY_ID", "");
      const getEnv = await loadGetEnv();

      expect(() => getEnv()).toThrow(/AWS_ACCESS_KEY_ID: Too small/);
    });

    // A production-style password source on top of the local password breaks the exactly-one rule, loudly.
    it("refuses a DATABASE_SECRET_ARN, since the local password is always set", async () => {
      stubLocalDev();
      vi.stubEnv("DATABASE_SECRET_ARN", "arn:aws:secretsmanager:us-west-2:123456789012:secret:rds");
      const getEnv = await loadGetEnv();

      expect(() => getEnv()).toThrow("set exactly one of DATABASE_PASSWORD or DATABASE_SECRET_ARN");
    });

    it("fixes the database and the app origin, whatever the environment holds", async () => {
      stubLocalDev();
      vi.stubEnv("DATABASE_HOST", "db.example.test");
      vi.stubEnv("DATABASE_NAME", "other");
      vi.stubEnv("APP_ORIGIN", "http://example.test:4000");

      const env = (await loadGetEnv())();

      expect(env).toMatchObject({
        DATABASE_HOST: "localhost",
        DATABASE_NAME: "ai_gaussian_splatter",
        APP_ORIGIN: "http://localhost:3000",
      });
    });
  });

  it("accepts a missing AWS_ACCESS_KEY_ID outside local dev, where the ECS task role supplies credentials", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AWS_ACCESS_KEY_ID", undefined);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", undefined);
    const getEnv = await loadGetEnv();

    expect(getEnv().AWS_ACCESS_KEY_ID).toBeUndefined();
  });

  it("refuses an APP_ORIGIN with a trailing slash outside local dev", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", "https://app.example.com/");
    const getEnv = await loadGetEnv();

    expect(() => getEnv()).toThrow("APP_ORIGIN: must not end with a slash");
  });

  it("defaults none of the database, the app URL, or the credentials in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", undefined);
    vi.stubEnv("DATABASE_HOST", undefined);
    vi.stubEnv("DATABASE_NAME", undefined);
    const getEnv = await loadGetEnv();

    expect(() => getEnv()).toThrow(/DATABASE_HOST.*DATABASE_NAME.*APP_ORIGIN/);
  });
});

describe("isLocalDev", () => {
  it("is true unless NODE_ENV is production or test", () => {
    expect(isLocalDev({})).toBe(true);
    expect(isLocalDev({ NODE_ENV: "development" })).toBe(true);
    expect(isLocalDev({ NODE_ENV: "production" })).toBe(false);
    expect(isLocalDev({ NODE_ENV: "test" })).toBe(false);
  });
});

describe("withLocalDevEnv", () => {
  it("points every DATABASE_* variable at splat-pg in local dev, where NODE_ENV is unset or development", () => {
    for (const nodeEnv of [undefined, "development"]) {
      expect(resolveDatabaseUrl(withLocalDevEnv({ NODE_ENV: nodeEnv }))).toBe(
        "postgresql://postgres:postgres@localhost:5432/ai_gaussian_splatter",
      );
    }
  });

  it("replaces a value the environment already holds", () => {
    const env = withLocalDevEnv({
      APP_ORIGIN: "http://example.test:4000",
      DATABASE_HOST: "db.internal",
      DATABASE_NAME: "other",
      DATABASE_PASSWORD: "s3cret",
    });

    expect(resolveDatabaseUrl(env)).toBe("postgresql://postgres:postgres@localhost:5432/ai_gaussian_splatter");
    expect(env.APP_ORIGIN).toBe(LOCAL_APP_ORIGIN);
  });

  it("changes nothing in production or tests", () => {
    for (const nodeEnv of ["production", "test"]) {
      const env = { NODE_ENV: nodeEnv, DATABASE_HOST: "db.internal" };

      expect(withLocalDevEnv(env)).toBe(env);
    }
  });
});
