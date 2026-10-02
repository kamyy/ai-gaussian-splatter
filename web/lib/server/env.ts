/**
 * The server's configuration, read and checked from environment variables, plus everything local dev fixes in code.
 *
 * getEnv() validates every variable once with zod and returns them typed, so a missing or malformed setting fails
 * clearly at the first request rather than deep inside a handler. Clerk needs no settings here beyond CLERK_SECRET_KEY,
 * which its SDK reads itself.
 *
 * `next dev`, `pnpm db:migrate` and `pnpm db:studio` run on the host against the `splat-pg` Postgres container, and the
 * app is always served on port 3000. Because those never change, they live here as literals, and web/.env lists only
 * the settings a developer actually chooses. withLocalDevEnv() applies them over the environment, so a stray shell
 * variable can't move dev elsewhere. Deploys and tests get none of them.
 *
 * The migrator image ships this file, because web/scripts/db-migrate.cjs calls withLocalDevEnv().
 *
 * These places repeat the port and can't import it:
 * - `scripts/dev/setup.sh` (the dev buckets' CORS origins)
 * - `web/package.json` (`next dev -p 3000`)
 * - `web/playwright.config.ts` (`next dev -p 3000`)
 */

import { z } from "zod";

const WORKER_INSTANCE_VARS = [
  "WORKER_AMI_ID",
  "WORKER_SUBNET_ID",
  "WORKER_SECURITY_GROUP_ID",
  "WORKER_INSTANCE_PROFILE_ARN",
  "WORKER_LOG_GROUP",
  "WORKER_DATA_ROLE_ARN",
] as const;

// web/.env.example starts each credential placeholder with this, and scripts/dev/setup.sh replaces them.
const PLACEHOLDER_PREFIX = "replace-with-";

/** The app's origin under `next dev -p 3000`. The sitemap and robots.txt build their URLs from it. */
export const LOCAL_APP_ORIGIN = "http://localhost:3000";

/**
 * The origin a local worker container reaches the app at. Inside the container, "localhost" is the container itself.
 * host.containers.internal is Podman's alias for the host running `next dev`.
 */
export const LOCAL_WORKER_CALLBACK_ORIGIN = "http://host.containers.internal:3000";

// The dev database on the `splat-pg` container that scripts/dev/db.sh creates.
const LOCAL_DATABASE_ENV = {
  DATABASE_HOST: "localhost",
  DATABASE_PORT: "5432",
  DATABASE_NAME: "ai_gaussian_splatter",
  DATABASE_USER: "postgres",
  DATABASE_PASSWORD: "postgres",
};

const envSchema = z
  .object({
    DATABASE_HOST: z.string().min(1),
    DATABASE_PORT: z.coerce.number().int().positive(),
    DATABASE_NAME: z.string().min(1),
    DATABASE_USER: z.string().min(1),
    // Exactly one of these is set. DATABASE_PASSWORD is a static value, used by local dev, CI, and the migration task,
    // which runs too briefly to hit RDS's 7-day rotation. DATABASE_SECRET_ARN is what the long-lived web service uses
    // instead. It fetches the current password from Secrets Manager for every new pg connection rather than trusting a
    // value ECS injected once at task start. See web/lib/server/databaseUrl.ts's fetchDatabasePassword.
    DATABASE_PASSWORD: z.string().min(1).optional(),
    DATABASE_SECRET_ARN: z.string().min(1).optional(),

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

    // What launching a real EC2 worker instance needs. Local dev always runs the worker under Podman instead, which
    // reads none of these, so the superRefine below requires them only outside local dev.
    WORKER_AMI_ID: z.string().min(1).optional(),
    WORKER_SUBNET_ID: z.string().min(1).optional(),
    WORKER_SECURITY_GROUP_ID: z.string().min(1).optional(),
    WORKER_INSTANCE_PROFILE_ARN: z.string().min(1).optional(),
    WORKER_LOG_GROUP: z.string().min(1).optional(),
    // The role whose credentials a worker instance gets for its own splat's S3 objects
    // (web/app/api/v1/internal/jobs/[jobId]/s3-credentials/route.ts).
    WORKER_DATA_ROLE_ARN: z.string().min(1).optional(),

    // The app's public origin. The GPU worker calls back to it, and the sitemap and robots.txt build their URLs from it.
    // A trailing slash is refused, because callers append paths and would double it.
    APP_ORIGIN: z
      .string()
      .url()
      .refine(origin => !origin.endsWith("/"), "must not end with a slash"),

    // The SSM Parameter Store path web/lib/server/runtimeSettings.ts reads the runtime settings from. Unset in local
    // dev and tests, which read those settings from env vars instead.
    RUNTIME_SETTINGS_PATH: z.string().min(1).optional(),
  })
  .refine(v => (v.DATABASE_PASSWORD === undefined) !== (v.DATABASE_SECRET_ARN === undefined), {
    message: "set exactly one of DATABASE_PASSWORD or DATABASE_SECRET_ARN",
    path: ["DATABASE_PASSWORD"],
  })
  // isLocalDev() reads process.env, the same source getEnv() parses, so the two can't disagree.
  .superRefine((v, ctx) => {
    if (!isLocalDev()) {
      for (const name of WORKER_INSTANCE_VARS) {
        if (v[name] === undefined) {
          ctx.addIssue({ code: "custom", message: "required outside local dev", path: [name] });
        }
      }

      return;
    }

    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const) {
      const value = v[name];
      if (value === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "required in local dev, so the SDK can't use ~/.aws/credentials",
          path: [name],
        });
      } else if (value.startsWith(PLACEHOLDER_PREFIX)) {
        ctx.addIssue({
          code: "custom",
          message: 'still the placeholder from web/.env.example (see "First-time setup" in RUNBOOK.md)',
          path: [name],
        });
      }
    }
  });

let cached: Env | null = null;

type Env = z.infer<typeof envSchema>;

/**
 * True when no deploy or test run is in charge of the environment: `next dev`, `pnpm db:migrate`, and `pnpm db:studio`.
 * The production images set NODE_ENV=production, and Vitest sets NODE_ENV=test.
 */
export function isLocalDev(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production" && env.NODE_ENV !== "test";
}

/**
 * `env` with the database and the app's origin set to the local values, whatever `env` held. Returns `env` untouched
 * outside local dev.
 */
export function withLocalDevEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  if (!isLocalDev(env)) {
    return env;
  }

  return { ...env, ...LOCAL_DATABASE_ENV, APP_ORIGIN: LOCAL_APP_ORIGIN };
}

/**
 * Parsed once on first use, not when the module loads. This mirrors worker/pipeline/config.py's lazy `get_settings()`.
 * Parsing at module load would run during `next build`, where these variables are legitimately unset.
 */
export function getEnv(): Env {
  if (cached === null) {
    const parsed = envSchema.safeParse(withLocalDevEnv(process.env));
    if (!parsed.success) {
      const detail = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", ");
      throw new Error(`Invalid server environment: ${detail}`);
    }

    cached = parsed.data;
  }

  return cached;
}

/**
 * The settings for launching a real EC2 worker instance, each one a string. getEnv() has already required them
 * outside local dev, so the throw here only fires for a caller that launches an instance anyway.
 */
export function getWorkerInstanceEnv(): Record<(typeof WORKER_INSTANCE_VARS)[number], string> {
  const env = getEnv();
  const missing = WORKER_INSTANCE_VARS.filter(name => env[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`Cannot launch an EC2 worker instance without ${missing.join(", ")}`);
  }

  return {
    WORKER_AMI_ID: env.WORKER_AMI_ID as string,
    WORKER_SUBNET_ID: env.WORKER_SUBNET_ID as string,
    WORKER_SECURITY_GROUP_ID: env.WORKER_SECURITY_GROUP_ID as string,
    WORKER_INSTANCE_PROFILE_ARN: env.WORKER_INSTANCE_PROFILE_ARN as string,
    WORKER_LOG_GROUP: env.WORKER_LOG_GROUP as string,
    WORKER_DATA_ROLE_ARN: env.WORKER_DATA_ROLE_ARN as string,
  };
}
