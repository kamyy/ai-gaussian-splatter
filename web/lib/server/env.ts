/**
 * The server's configuration, read and checked from environment variables, plus everything local dev fixes in code.
 *
 * getEnv() validates every variable once with zod and returns them typed, so a missing or malformed setting fails
 * clearly at the first request rather than deep inside a handler. Clerk needs no settings here beyond CLERK_SECRET_KEY,
 * which its SDK reads itself.
 *
 * The checked variables are four groups: the database, AWS, the worker instance, and this Next process. They are joined
 * before the checks that look across groups.
 *
 * `next dev`, `pnpm db:migrate` and `pnpm db:studio` run on the host against the `splat-pg` Postgres container, and the
 * app is always served on port 3000. Because those never change, they live here as literals, and web/.env lists only
 * the settings a developer actually chooses. getEnv() applies them over the environment, so a stray shell
 * variable can't move dev elsewhere. Deploys and tests get none of them.
 *
 * The migrator image ships this file, because web/scripts/db-migrate.cjs reads LOCAL_DATABASE_ENV and isLocalDevEnv().
 *
 * These places repeat the port and can't import it:
 * - `scripts/dev/setup.sh` (the dev buckets' CORS origins)
 * - `web/package.json` (`next dev -p 3000`)
 * - `web/playwright.config.ts` (`next dev -p 3000`)
 */

import { z } from "zod";

/** The app's origin under `next dev -p 3000`. The sitemap and robots.txt build their URLs from it. */
export const LOCAL_APP_ORIGIN = "http://localhost:3000";

/** The `splat-pg` database. Local dev always uses it, including web/scripts/db-migrate.cjs. */
export const LOCAL_DATABASE_ENV = {
  DATABASE_HOST: "localhost",
  DATABASE_PORT: "5432",
  DATABASE_NAME: "ai_gaussian_splatter",
  DATABASE_USER: "postgres",
  DATABASE_PASSWORD: "postgres",
};

// --- Database ------------------------------------------------------------------------
const databaseEnv = z.object({
  DATABASE_HOST: z.string().min(1),
  DATABASE_PORT: z.string().min(4),
  DATABASE_NAME: z.string().min(1),
  DATABASE_USER: z.string().min(1),
  // Static password. Exactly one of DATABASE_PASSWORD and DATABASE_SECRET_ARN is set. Local dev uses the `splat-pg`
  // container's `ai_gaussian_splatter` database. CI's `ci-postgres` container serves `ai_gaussian_splatter` to the
  // migrator image and `pnpm db:migrate`, and `ai_gaussian_splatter_test` to Vitest. The migration task migrates RDS's
  // `ai_gaussian_splatter` database with the master password ECS injects once, and exits inside the 7-day rotation.
  DATABASE_PASSWORD: z.string().min(1).optional(),
  // The long-lived web service sets DATABASE_SECRET_ARN. The value names the RDS master secret. The service fetches the
  // current password on every new connection to RDS's `ai_gaussian_splatter` database. See
  // web/lib/server/databaseUrl.ts's fetchDatabasePassword.
  DATABASE_SECRET_ARN: z.string().min(1).optional(),
});

// --- AWS -----------------------------------------------------------------------------
const awsEnv = z.object({
  UPLOADS_BUCKET: z.string().min(1),
  SPLATS_BUCKET: z.string().min(1),
  // No default: every path that runs this app sets it (infra/web.tf for ECS, web/.env for local dev,
  // .github/workflows/ci.yml for tests), and a default would quietly sign against the wrong region for a deploy that
  // moved.
  AWS_REGION: z.string().min(1),
  // The dev IAM user's static keys. Local dev requires real ones (the superRefine below), because the AWS SDK falls
  // back to ~/.aws/credentials without them and would sign with whichever IAM user that profile names. Deploys leave
  // them unset: the ECS task role supplies credentials there.
  AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
});

// --- Worker instance -----------------------------------------------------------------
// What launching a real EC2 worker instance needs. Local dev always runs the worker under Podman instead, which
// reads none of these, so the superRefine below requires them only outside local dev.
const WORKER_INSTANCE_ENV_VARS = [
  "WORKER_AMI_ID",
  "WORKER_SUBNET_ID",
  "WORKER_SECURITY_GROUP_ID",
  "WORKER_INSTANCE_PROFILE_ARN",
  "WORKER_LOG_GROUP",
  "WORKER_DATA_ROLE_ARN",
] as const;

const workerInstanceEnv = z.object({
  WORKER_AMI_ID: z.string().min(1).optional(),
  WORKER_SUBNET_ID: z.string().min(1).optional(),
  WORKER_SECURITY_GROUP_ID: z.string().min(1).optional(),
  WORKER_INSTANCE_PROFILE_ARN: z.string().min(1).optional(),
  WORKER_LOG_GROUP: z.string().min(1).optional(),
  // The role whose credentials a worker instance gets for its own splat's S3 objects
  // (web/app/api/v1/internal/jobs/[jobId]/s3-credentials/route.ts).
  WORKER_DATA_ROLE_ARN: z.string().min(1).optional(),
});

// --- App -----------------------------------------------------------------------------
const appEnv = z.object({
  // The app's public origin. The GPU worker calls back to it, and the sitemap and robots.txt build their URLs from it.
  // A trailing slash is refused, because callers append paths and would double it.
  APP_ORIGIN: z.url().refine(origin => !origin.endsWith("/"), "must not end with a slash"),

  // The SSM Parameter Store path web/lib/server/runtimeSettings.ts reads the runtime settings from. Unset in local
  // dev and tests, which read those settings from env vars instead.
  RUNTIME_SETTINGS_PATH: z.string().min(1).optional(),
});

// --- Joined schema -------------------------------------------------------------------
function hasExactlyOneDatabasePassword(env: { DATABASE_PASSWORD?: string; DATABASE_SECRET_ARN?: string }): boolean {
  return (env.DATABASE_PASSWORD === undefined) !== (env.DATABASE_SECRET_ARN === undefined);
}

function requireWorkerInstanceEnvKeys(
  env: { [K in (typeof WORKER_INSTANCE_ENV_VARS)[number]]?: string },
  ctx: z.core.$RefinementCtx,
): void {
  if (!isLocalDevEnv()) {
    for (const name of WORKER_INSTANCE_ENV_VARS) {
      if (env[name] === undefined) {
        ctx.addIssue({ code: "custom", message: "required outside local dev", path: [name] });
      }
    }
  }
}

function requireAwsAccessEnvKeys(
  env: { AWS_ACCESS_KEY_ID?: string; AWS_SECRET_ACCESS_KEY?: string },
  ctx: z.core.$RefinementCtx,
): void {
  if (isLocalDevEnv()) {
    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const) {
      const value = env[name];
      if (value === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "required in local dev, so the SDK can't use ~/.aws/credentials",
          path: [name],
        });
      } else if (value.startsWith("replace-with-")) {
        // web/.env.example starts each placeholder with "replace-with-", and scripts/dev/setup.sh replaces them.
        ctx.addIssue({
          code: "custom",
          message: 'still the placeholder from web/.env.example (see "First-time setup" in RUNBOOK.md)',
          path: [name],
        });
      }
    }
  }
}

// refine and superRefine return a wrapper that is no longer an object schema, so these checks cannot be applied to a
// group and then extended.
const envSchema = databaseEnv
  .extend(awsEnv.shape)
  .extend(workerInstanceEnv.shape)
  .extend(appEnv.shape)
  .refine(hasExactlyOneDatabasePassword, {
    message: "set exactly one of DATABASE_PASSWORD or DATABASE_SECRET_ARN",
    path: ["DATABASE_PASSWORD"],
  })
  .superRefine(requireWorkerInstanceEnvKeys)
  .superRefine(requireAwsAccessEnvKeys);

type ParsedEnv = z.infer<typeof envSchema>;

// --- Readers -------------------------------------------------------------------------
let cached: ParsedEnv | null = null;

/**
 * True when no deploy or test run is in charge of the environment: `next dev`, `pnpm db:migrate`, and
 * `pnpm db:studio`. The production images set NODE_ENV=production, and Vitest sets NODE_ENV=test.
 */
export function isLocalDevEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production" && env.NODE_ENV !== "test";
}

/**
 * Parsed once on first use, not when the module loads. This mirrors worker/pipeline/config.py's lazy `get_settings()`.
 * Parsing at module load would run during `next build`, where these variables are legitimately unset.
 */
export function getEnv(): ParsedEnv {
  if (cached === null) {
    const environment = isLocalDevEnv(process.env)
      ? { ...process.env, ...LOCAL_DATABASE_ENV, APP_ORIGIN: LOCAL_APP_ORIGIN }
      : process.env;

    const parsed = envSchema.safeParse(environment);
    if (!parsed.success) {
      const detail = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", ");
      throw new Error(`Invalid server environment: ${detail}`);
    }
    cached = parsed.data;
  }

  return cached;
}
