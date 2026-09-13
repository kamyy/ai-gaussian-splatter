import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearDatabasePasswordCache, fetchDatabasePassword } from "../databaseUrl";
import { SecretPasswordPool } from "../db";

/**
 * Requires a real Postgres (TEST_DATABASE_URL): the retry keys off the `28P01` error Postgres itself sends for a
 * rejected password, which a mocked pool couldn't prove. Secrets Manager is mocked to play the part of a rotation.
 */
const hasPostgres = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasPostgres)("SecretPasswordPool", () => {
  const secretsMock = mockClient(SecretsManagerClient);
  const arn = "arn:aws:secretsmanager:us-west-2:000000000000:secret:rotating";
  let pool: SecretPasswordPool | undefined;

  function testDbUrl(): URL {
    return new URL(process.env.TEST_DATABASE_URL as string);
  }

  function secretWith(password: string) {
    return { SecretString: JSON.stringify({ password }) };
  }

  function createPool(database = testDbUrl().pathname.slice(1)): SecretPasswordPool {
    const url = testDbUrl();
    pool = new SecretPasswordPool({
      host: url.hostname,
      port: Number(url.port || 5432),
      database,
      user: decodeURIComponent(url.username),
      password: () => fetchDatabasePassword(arn, "us-west-2"),
    });
    return pool;
  }

  beforeEach(() => {
    secretsMock.reset();
    clearDatabasePasswordCache();
  });

  afterEach(async () => {
    await pool?.end();
    pool = undefined;
  });

  it("re-fetches a rejected cached password and retries pool.query once", async () => {
    const current = decodeURIComponent(testDbUrl().password);
    secretsMock.on(GetSecretValueCommand).resolvesOnce(secretWith("stale")).resolves(secretWith(current));

    await expect(createPool().query("select 1 as ok")).resolves.toMatchObject({ rows: [{ ok: 1 }] });
    expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
  });

  it("retries connect() the same way, which drizzle's transaction() goes through", async () => {
    const current = decodeURIComponent(testDbUrl().password);
    secretsMock.on(GetSecretValueCommand).resolvesOnce(secretWith("stale")).resolves(secretWith(current));

    const client = await createPool().connect();
    client.release();
    expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
  });

  it("gives up after one retry when the re-fetched password is rejected too", async () => {
    secretsMock.on(GetSecretValueCommand).resolves(secretWith("wrong"));

    await expect(createPool().query("select 1")).rejects.toMatchObject({ code: "28P01" });
    expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(2);
  });

  it("keeps the cache and doesn't retry on errors other than a rejected password", async () => {
    secretsMock.on(GetSecretValueCommand).resolves(secretWith(decodeURIComponent(testDbUrl().password)));

    await expect(createPool("does_not_exist").query("select 1")).rejects.toMatchObject({ code: "3D000" });
    expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });
});
