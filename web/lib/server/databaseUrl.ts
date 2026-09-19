import { readFileSync } from "node:fs";

import type { ConnectionOptions } from "node:tls";

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/**
 * TLS settings for the Postgres connection, or undefined for a plain one. Driven by `DATABASE_SSL_CA`, a path to a PEM
 * bundle: set it (production, pointed at the bundle `web/Dockerfile` bakes in) and the connection is encrypted and
 * verified against that bundle; leave it unset (local dev, CI) and the connection is plain.
 *
 * `rejectUnauthorized` is deliberately not passed, so it stays at Node's default `true`. Reaching for
 * `?sslmode=require` instead does not do what its name suggests here — see AGENTS.md.
 */
export function databaseSsl(env: Record<string, string | undefined> = process.env): ConnectionOptions | undefined {
  const caPath = env.DATABASE_SSL_CA;
  if (!caPath) {
    return undefined;
  }
  return { ca: readFileSync(caPath, "utf8") };
}

/**
 * Resolves the Postgres connection string from `DATABASE_HOST` / `DATABASE_PORT` / `DATABASE_NAME` / `DATABASE_USER` /
 * `DATABASE_PASSWORD`, since ECS cannot itself assemble a `postgresql://` URL out of the Secrets Manager JSON blob
 * RDS generates (see `infra/web.tf`). Used by local dev, CI, `drizzle-kit`, and the migration task — not by the
 * production web service, which fetches its password at connect time instead (see `fetchDatabasePassword`, below)
 * and never assembles a single connection string.
 *
 * Credentials are percent-encoded: an RDS-generated password can contain `:` `?` `#` `%`, any of which would corrupt
 * the URL otherwise; `pg` decodes them back on connect.
 *
 * Returns undefined rather than throwing when nothing is configured, so `drizzle-kit generate` — which needs no
 * database — keeps working.
 */
export function resolveDatabaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const host = env.DATABASE_HOST;
  const name = env.DATABASE_NAME;
  const user = env.DATABASE_USER;
  const password = env.DATABASE_PASSWORD;
  if (!host || !name || !user || !password) {
    return undefined;
  }

  const port = env.DATABASE_PORT || "5432";
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}`;
}

const PASSWORD_CACHE_TTL_MS = 5 * 60 * 1000;

let secretsClient: SecretsManagerClient | undefined;
let cachedPassword: { secretArn: string; value: string; fetchedAt: number } | undefined;

/**
 * Fetches the RDS master password from Secrets Manager on demand, rather than trusting a value ECS injected once at
 * task start. RDS rotates that secret, and the failure it causes is gradual rather than a clean cutover (AGENTS.md).
 *
 * `getDb()` (web/lib/server/db/index.ts) passes this as a `pg.Pool` `password` callback, so it re-runs on every new
 * physical connection instead of once. The cache keeps a pool opening many connections at once from calling Secrets
 * Manager for each one. A rotation makes the cached value wrong immediately rather than at the TTL, which is why
 * `SecretPasswordPool` (web/lib/server/db/index.ts) clears the cache and retries once when Postgres rejects it.
 *
 * Not used by the migration task (web/scripts/db-migrate.cjs), which runs for seconds on the static
 * DATABASE_PASSWORD ECS injects at its own task start.
 */
export async function fetchDatabasePassword(secretArn: string, region: string): Promise<string> {
  const now = Date.now();
  if (
    cachedPassword &&
    cachedPassword.secretArn === secretArn &&
    now - cachedPassword.fetchedAt < PASSWORD_CACHE_TTL_MS
  ) {
    return cachedPassword.value;
  }

  // Without an explicit region, the SDK's own default-region resolution can land somewhere other than where the
  // secret actually lives (e.g. RDS's region), failing with a not-found rather than an auth error. It matches how
  // web/lib/server/s3.ts and web/lib/server/ec2Launcher.ts already pass region: getEnv().AWS_REGION to their own
  // clients rather than omitting it.
  secretsClient ??= new SecretsManagerClient({ region });
  const { SecretString } = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!SecretString) {
    throw new Error(`Secret ${secretArn} has no SecretString`);
  }

  const { password } = JSON.parse(SecretString) as { password: unknown };
  if (typeof password !== "string" || password.length === 0) {
    throw new Error(`Secret ${secretArn} has no password field`);
  }

  cachedPassword = { secretArn, value: password, fetchedAt: now };
  return password;
}

/**
 * Drops the cached password so the next connection fetches a fresh one from Secrets Manager. `SecretPasswordPool`
 * (web/lib/server/db/index.ts) calls it when Postgres rejects the cached value. Tests call it so one test's cached
 * password can't leak into another's.
 */
export function clearDatabasePasswordCache(): void {
  cachedPassword = undefined;
}
