import { readFileSync } from "node:fs";

import type { ConnectionOptions } from "node:tls";

/**
 * TLS settings for the Postgres connection, or undefined for a plain one.
 *
 * Driven by `DATABASE_SSL_CA`, a path to a PEM bundle. Set it and the
 * connection is encrypted *and* the server certificate is verified against
 * that bundle; leave it unset (local dev, CI) and the connection is plain.
 *
 * This exists because RDS for PostgreSQL 15+ ships `rds.force_ssl = 1` in its
 * default parameter group, so a production connection without TLS is rejected
 * outright — while `pg` defaults to no TLS. The obvious-looking fix of
 * appending `?sslmode=require` to the URL does **not** work: `pg` currently
 * treats `require` as an alias for `verify-full` (it sets `ssl = {}`, leaving
 * Node's `rejectUnauthorized: true`), and RDS certificates chain to Amazon's
 * own RDS root CAs, which are not in Node's bundled trust store. That swaps a
 * "no encryption" failure for a "cannot verify certificate" one.
 *
 * So the CA bundle has to be supplied. `web/Dockerfile` downloads Amazon's
 * global bundle into the image and points `DATABASE_SSL_CA` at it.
 * `rejectUnauthorized` is deliberately left at its default of true: with the
 * right CA present there is no reason to accept an unverified server, and
 * turning it off would leave the connection open to interception.
 */
export function databaseSsl(env: Record<string, string | undefined> = process.env): ConnectionOptions | undefined {
  const caPath = env.DATABASE_SSL_CA;
  if (!caPath) {
    return undefined;
  }
  return { ca: readFileSync(caPath, "utf8") };
}

/**
 * Resolves the Postgres connection string from the environment.
 *
 * Two supported shapes, because the two places this runs supply it differently:
 *
 * - `DATABASE_URL` — a complete `postgresql://…` string. What local dev, CI,
 *   the Docker Compose-style container run, and `drizzle-kit` all use.
 * - `DATABASE_HOST` / `DATABASE_PORT` / `DATABASE_NAME` / `DATABASE_USER` /
 *   `DATABASE_PASSWORD` — the parts, assembled here. What ECS supplies in
 *   production: RDS generates its credentials into a Secrets Manager secret
 *   whose value is a JSON blob, and ECS can only project *fields* of that blob
 *   into individual environment variables (the `arn:key::` selector in
 *   `infra/stacks/backend_stack.py`). There is no way to have AWS hand the
 *   container an assembled URL — hence this.
 *
 * `DATABASE_URL` wins when both are present, so a deployed task can be pointed
 * at a different database by overriding one variable.
 *
 * Credentials are percent-encoded: the RDS-generated password is random and,
 * while `from_generated_secret` excludes `"@/\`, nothing stops it containing
 * `:`, `?`, `#` or `%`, any of which would silently truncate or corrupt the
 * URL. `pg` decodes these back, so encoding here is safe as well as necessary.
 *
 * Returns undefined rather than throwing when nothing is configured —
 * `drizzle-kit generate` needs no database at all, and must keep working.
 */
export function resolveDatabaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.DATABASE_URL) {
    return env.DATABASE_URL;
  }

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
