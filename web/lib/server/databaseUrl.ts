import { readFileSync } from "node:fs";

import type { ConnectionOptions } from "node:tls";

/**
 * TLS settings for the Postgres connection, or undefined for a plain one.
 * Driven by `DATABASE_SSL_CA`, a path to a PEM bundle: set it and the
 * connection is encrypted and verified against that bundle; leave it unset
 * (local dev, CI) and the connection is plain.
 *
 * RDS Postgres 15+ rejects unencrypted connections outright (`rds.force_ssl
 * = 1`), while `pg` defaults to no TLS. Appending `?sslmode=require` looks
 * like the fix but isn't: `pg` treats `require` as `verify-full`
 * (`rejectUnauthorized: true`), and RDS's certificates chain to Amazon's own
 * root CAs, which aren't in Node's trust store — so `require` just trades a
 * "no encryption" error for "cannot verify certificate."
 *
 * Supplying the CA bundle is the actual fix: `web/Dockerfile` downloads
 * Amazon's bundle into the image and points `DATABASE_SSL_CA` at it.
 * `rejectUnauthorized` stays at its default `true` — with the right CA
 * present, there's no reason to accept an unverified server.
 */
export function databaseSsl(env: Record<string, string | undefined> = process.env): ConnectionOptions | undefined {
  const caPath = env.DATABASE_SSL_CA;
  if (!caPath) {
    return undefined;
  }
  return { ca: readFileSync(caPath, "utf8") };
}

/**
 * Resolves the Postgres connection string from `DATABASE_HOST` /
 * `DATABASE_PORT` / `DATABASE_NAME` / `DATABASE_USER` / `DATABASE_PASSWORD` —
 * the only shape accepted, everywhere from local dev to production, since ECS
 * cannot itself assemble a `postgresql://` URL out of the Secrets Manager
 * JSON blob RDS generates (see `infra/stacks/backend_stack.py`).
 *
 * Credentials are percent-encoded: an RDS-generated password can contain `:`
 * `?` `#` `%`, any of which would corrupt the URL otherwise; `pg` decodes
 * them back on connect.
 *
 * Returns undefined rather than throwing when nothing is configured, so
 * `drizzle-kit generate` — which needs no database — keeps working.
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
