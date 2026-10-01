/**
 * The server's configuration, read and checked from environment variables.
 *
 * getEnv() validates every variable once with zod and returns them typed, so a missing or malformed setting fails
 * clearly at the first request rather than deep inside a handler. Clerk needs no settings here beyond CLERK_SECRET_KEY,
 * which its SDK reads itself.
 */

import { z } from "zod";

const WORKER_INSTANCE_VARS = [
  "WORKER_AMI_ID",
  "WORKER_SUBNET_ID",
  "WORKER_SECURITY_GROUP_ID",
  "WORKER_INSTANCE_PROFILE_ARN",
  "WORKER_LOG_GROUP",
] as const;

const envSchema = z
  .object({
    DATABASE_HOST: z.string().min(1),
    DATABASE_PORT: z.coerce.number().int().positive().default(5432),
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
    // No default: every path that runs this app sets it (infra/web.tf for ECS, web/.env for local dev and the
    // container, .github/workflows/ci.yml for tests), and a default would quietly sign against the wrong region
    // for a deploy that moved.
    AWS_REGION: z.string().min(1),

    // What launching a real EC2 worker instance needs. Local dev runs the worker under Podman instead
    // (WORKER_LOCAL_LAUNCH), which reads none of these, so the superRefine below requires them only when that is off.
    WORKER_LOCAL_LAUNCH: z.string().optional(),
    WORKER_AMI_ID: z.string().min(1).optional(),
    WORKER_SUBNET_ID: z.string().min(1).optional(),
    WORKER_SECURITY_GROUP_ID: z.string().min(1).optional(),
    WORKER_INSTANCE_PROFILE_ARN: z.string().min(1).optional(),
    WORKER_LOG_GROUP: z.string().min(1).optional(),

    // Where the GPU worker PATCHes its status back to.
    APP_PUBLIC_URL: z.string().url(),

    // The SSM Parameter Store path web/lib/server/runtimeSettings.ts reads the runtime settings from. Unset in local
    // dev and tests, which read those settings from env vars instead.
    RUNTIME_SETTINGS_PATH: z.string().min(1).optional(),
  })
  .refine(v => (v.DATABASE_PASSWORD === undefined) !== (v.DATABASE_SECRET_ARN === undefined), {
    message: "set exactly one of DATABASE_PASSWORD or DATABASE_SECRET_ARN",
    path: ["DATABASE_PASSWORD"],
  })
  .superRefine((v, ctx) => {
    if (v.WORKER_LOCAL_LAUNCH === "true") {
      return;
    }

    for (const name of WORKER_INSTANCE_VARS) {
      if (v[name] === undefined) {
        ctx.addIssue({ code: "custom", message: "required unless WORKER_LOCAL_LAUNCH is true", path: [name] });
      }
    }
  });

let cached: Env | null = null;

type Env = z.infer<typeof envSchema>;

/**
 * Parsed once on first use, not when the module loads. This mirrors worker/pipeline/config.py's lazy `get_settings()`.
 * Parsing at module load would run during `next build`, where these variables are legitimately unset.
 */
export function getEnv(): Env {
  if (cached === null) {
    const parsed = envSchema.safeParse(process.env);
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
 * whenever WORKER_LOCAL_LAUNCH is off, so the throw here only fires for a caller that launches an instance anyway.
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
  };
}
