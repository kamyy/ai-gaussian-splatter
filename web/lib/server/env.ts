import { z } from "zod";

/** Server-side configuration. Clerk needs no JWKS settings. Its SDK verifies sessions from CLERK_SECRET_KEY. */
const envSchema = z
  .object({
    DATABASE_HOST: z.string().min(1),
    DATABASE_PORT: z.coerce.number().int().positive().default(5432),
    DATABASE_NAME: z.string().min(1),
    DATABASE_USER: z.string().min(1),
    // Exactly one of these: DATABASE_PASSWORD is a static value (local dev, CI, and the migration task, which runs
    // too briefly to hit RDS's 7-day rotation). DATABASE_SECRET_ARN is what the long-lived web service uses
    // instead, fetching the current password from Secrets Manager on every new pg connection rather than trusting
    // a value ECS injected once at task start — see web/lib/server/databaseUrl.ts's fetchDatabasePassword.
    DATABASE_PASSWORD: z.string().min(1).optional(),
    DATABASE_SECRET_ARN: z.string().min(1).optional(),

    UPLOADS_BUCKET: z.string().min(1),
    SPLATS_BUCKET: z.string().min(1),
    // No default: every path that runs this app sets it (infra/web.tf for ECS, web/.env for local dev and the
    // container, .github/workflows/ci.yml for tests), and a default would quietly sign against the wrong region
    // for a deploy that moved.
    AWS_REGION: z.string().min(1),

    WORKER_AMI_ID: z.string().min(1),
    WORKER_INSTANCE_TYPE: z.string().min(1).default("g5.xlarge"),
    WORKER_SUBNET_ID: z.string().min(1),
    WORKER_SECURITY_GROUP_ID: z.string().min(1),
    WORKER_INSTANCE_PROFILE_ARN: z.string().min(1),

    // Rate limiting — deliberately simple config knobs, not architecture. Tune based on real usage once deployed.
    RATE_LIMIT_IP_PER_HOUR: z.coerce.number().int().positive().default(5),
    RATE_LIMIT_USER_PER_DAY: z.coerce.number().int().positive().default(3),
    GLOBAL_MAX_JOBS_PER_DAY: z.coerce.number().int().positive().default(20),
    MIN_PHOTOS_PER_SPLAT: z.coerce.number().int().positive().default(20),

    // Where the GPU worker PATCHes its status back to.
    APP_PUBLIC_URL: z.string().url(),
  })
  .refine(v => (v.DATABASE_PASSWORD === undefined) !== (v.DATABASE_SECRET_ARN === undefined), {
    message: "set exactly one of DATABASE_PASSWORD or DATABASE_SECRET_ARN",
    path: ["DATABASE_PASSWORD"],
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Parsed once on first use, not at module load — mirrors worker/pipeline/config.py's lazy `get_settings()`. Module-load
 * parsing would run during `next build`, where these vars legitimately aren't set.
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
