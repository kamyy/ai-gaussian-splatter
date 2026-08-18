import { z } from "zod";

import { resolveDatabaseUrl } from "./databaseUrl";

/** Server-side configuration. Clerk needs no JWKS settings — its SDK verifies sessions from CLERK_SECRET_KEY. */
const envSchema = z.object({
  // Assembled by resolveDatabaseUrl() before parsing, from the
  // DATABASE_HOST/NAME/USER/PASSWORD parts ECS projects out of the RDS
  // secret. See databaseUrl.ts.
  DATABASE_URL: z.string().min(1, "set DATABASE_HOST, DATABASE_NAME, DATABASE_USER and DATABASE_PASSWORD"),

  UPLOADS_BUCKET: z.string().min(1),
  SPLATS_BUCKET: z.string().min(1),
  AWS_REGION: z.string().min(1).default("us-west-2"),

  WORKER_AMI_ID: z.string().min(1),
  WORKER_INSTANCE_TYPE: z.string().min(1).default("g5.xlarge"),
  WORKER_SUBNET_ID: z.string().min(1),
  WORKER_SECURITY_GROUP_ID: z.string().min(1),
  WORKER_INSTANCE_PROFILE_ARN: z.string().min(1),

  // Rate limiting — deliberately simple config knobs, not
  // architecture; tune based on real usage once deployed.
  RATE_LIMIT_IP_PER_HOUR: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_USER_PER_DAY: z.coerce.number().int().positive().default(3),
  GLOBAL_MAX_JOBS_PER_DAY: z.coerce.number().int().positive().default(20),
  MIN_PHOTOS_PER_SPLAT: z.coerce.number().int().positive().default(20),

  // Where the GPU worker PATCHes its status back to.
  APP_PUBLIC_URL: z.string().url(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Parsed once on first use, not at module load — mirrors config.py's lazy
 * `get_settings()`. Module-load parsing would run during `next build`, where
 * these vars legitimately aren't set.
 */
export function getEnv(): Env {
  if (cached === null) {
    const parsed = envSchema.safeParse({ ...process.env, DATABASE_URL: resolveDatabaseUrl() ?? "" });
    if (!parsed.success) {
      const detail = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", ");
      throw new Error(`Invalid server environment: ${detail}`);
    }
    cached = parsed.data;
  }
  return cached;
}
