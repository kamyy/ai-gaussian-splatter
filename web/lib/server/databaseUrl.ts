import { readFileSync } from "node:fs";

import type { ConnectionOptions } from "node:tls";

/**
 * TLS settings for the Postgres connection, or undefined for a plain one.
 * Driven by `DATABASE_SSL_CA`, a path to a PEM bundle: set it (production,
 * pointed at the bundle `web/Dockerfile` bakes in) and the connection is
 * encrypted and verified against that bundle; leave it unset (local dev, CI)
 * and the connection is plain.
 *
 * `rejectUnauthorized` is deliberately not passed, so it stays at Node's
 * default `true`. Reaching for `?sslmode=require` instead does not do what
 * its name suggests here — see AGENTS.md.
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
