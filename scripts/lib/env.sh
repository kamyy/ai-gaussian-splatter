# shellcheck shell=bash
# Sourced by scripts/dev/create-resources.sh, scripts/lib/worker.sh, and scripts/dev/run-web-container.sh.
# web/.env isn't committed, so the template below is the only record of what it holds. Not meant to be run directly.

# Usage: env_create_file <env-file> <template-function> [template-arg...]
#
# Writes the template to the file only when nothing is there yet, so a re-run never replaces values filled in by hand.
# The file is readable only by its owner, because it ends up holding the dev user's secret key.
env_create_file() {
  local env_file=$1 template=$2
  shift 2
  if [[ -f $env_file ]]; then
    echo "$env_file already exists. Keeping it."
    return
  fi

  (umask 077 && "$template" "$@" >"$env_file")
  echo "Created $env_file."
}

# Usage: env_set <env-file> <env-var> <env-val>
#
# Replaces that variable's line, or appends one when there isn't any. The value reaches awk through the environment
# rather than inside an awk or sed expression, because AWS secret keys can contain / and +.
env_set() {
  local env_file=$1 env_var=$2 env_val=$3 tmp
  if ! grep -q "^$env_var=" "$env_file"; then
    if [[ -s $env_file && -n $(tail -c1 "$env_file") ]]; then
      # Without a final newline, the appended line would be glued onto the file's last one.
      printf '\n' >> "$env_file"
    fi
    printf '%s=%s\n' "$env_var" "$env_val" >>"$env_file"
    return
  fi

  tmp=$(mktemp)
  ENV_VAR=$env_var ENV_VAL=$env_val awk '
    index($0, ENVIRON["ENV_VAR"] "=") == 1 { $0 = ENVIRON["ENV_VAR"] "=" ENVIRON["ENV_VAL"] }
    { print }' "$env_file" >"$tmp"
  # Copied back rather than moved, so the file keeps its own permissions.
  cat "$tmp" >"$env_file"
  rm -f "$tmp"
}

# Usage: env_get <env-file> <env-var>
#
# Prints that variable's value, or exits naming the file and variable when it's missing or empty.
env_get() {
  local env_file=$1 env_var=$2 env_val
  env_val=$(grep -oP -m1 "^$env_var=\K.*" "$env_file" || true)
  if [[ -z $env_val ]]; then
    echo "$env_file has no $env_var value." >&2
    exit 1
  fi

  printf '%s\n' "$env_val"
}

# Usage: web_env_template <aws-account-id> <aws-region>
#
# The account id and region are interpolated, so the template is split in two: this half expands, and the rest is
# quoted so its backticks and dollar signs stay literal.
web_env_template() {
  local account_id=$1 region=$2
  cat <<EOF
# Local dev config for the web app. scripts/lib/worker.sh also reads its AWS keys, region, and buckets for local worker
# runs. scripts/dev/create-resources.sh writes this file when web/.env is missing, and never replaces an existing
# one. Fill in the Clerk keys. Read by web/lib/server/env.ts unless noted otherwise.

# The two dev buckets from "Dev AWS resources" in RUNBOOK.md. One S3 bucket namespace spans every AWS account, so the
# account id is what keeps these names from colliding with someone else's.
UPLOADS_BUCKET=ai-gaussian-splatter-dev-uploads-$account_id
SPLATS_BUCKET=ai-gaussian-splatter-dev-splats-$account_id

# The AWS region the buckets and credentials below are used against. web/lib/server/env.ts reads it and hands it to
# every S3 and EC2 client explicitly. The worker gets the same value as AWS_DEFAULT_REGION (scripts/lib/worker.sh,
# web/lib/server/ec2Launcher.ts), because boto3 reads only AWS_DEFAULT_REGION and the AWS SDK for JavaScript reads only
# AWS_REGION. Seeded from var.aws_region's default in infra/variables.tf so dev and production agree.
AWS_REGION=$region
EOF
  cat <<'EOF'

# The dev IAM user scoped to those two buckets. scripts/dev/create-resources.sh writes its key pair here when it
# creates the user's access key. Kept here rather than in ~/.aws/credentials because `next dev` loads this file, and
# because the SDK's env provider tests these for truthiness: an empty value counts as absent and the chain falls through
# to ~/.aws/credentials, signing upload URLs with whatever profile is configured there. The placeholders are non-empty
# so an unedited .env fails with a 403 instead of quietly using an admin profile.
AWS_ACCESS_KEY_ID=replace-with-dev-user-key
AWS_SECRET_ACCESS_KEY=replace-with-dev-user-secret

# Where the worker PATCHes job status back to, and the origin the web app hands the worker at launch. Inside the worker
# container localhost is the container itself, so local worker runs get http://host.containers.internal:3000 instead —
# Podman's alias for the host running `next dev`. In production the web app and the worker use the same public hostname.
# With nothing listening, status callbacks log a warning and the run continues.
APP_PUBLIC_URL=http://localhost:3000

# Clerk — CLERK_SECRET_KEY also backs server-side session verification (web/lib/server/auth.ts, proxy.ts). Read directly
# off process.env by @clerk/nextjs, not through env.ts.
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=

# Points Clerk at the embedded sign-in/sign-up pages under app/. Without these it redirects to its hosted Account Portal
# on accounts.dev instead.
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/splats
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/splats

# Clerk telemetry is collected from development instances only. The NEXT_PUBLIC_ prefix is required: @clerk/nextjs reads
# this name server-side and also inlines it into the browser bundle.
NEXT_PUBLIC_CLERK_TELEMETRY_DISABLED=1

# Postgres for local dev — the five parts of the connection URL that web/lib/server/databaseUrl.ts reassembles into
# postgresql://. Kept split to match production, where RDS stores its generated credentials as a JSON blob that ECS
# cannot assemble into a URL itself. "Web (frontend + REST API)" in RUNBOOK.md starts the container they address.
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=ai_gaussian_splatter
DATABASE_USER=postgres
DATABASE_PASSWORD=postgres

# Test database on the same splat-pg instance (scripts/dev/db-up.sh). web/vitest.config.mts reads this one line from
# this file, so `pnpm test` needs no prefix. Not read by web/lib/server/env.ts. pnpm db:migrate still uses DATABASE_*
# above.
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_gaussian_splatter_test

# GPU spot worker launch config, read by web/lib/server/ec2Launcher.ts when Process launches a real EC2 instance.
# getEnv() runs a single zod safeParse over the whole schema and its first caller is the DB pool, so empty values here
# would fail every DB-backed route. Non-empty placeholders keep the failure on the launch path, where it means
# something.
WORKER_AMI_ID=replace-with-worker-ami-id
WORKER_INSTANCE_TYPE=g5.xlarge
WORKER_SUBNET_ID=replace-with-worker-subnet-id
WORKER_SECURITY_GROUP_ID=replace-with-worker-security-group-id
WORKER_INSTANCE_PROFILE_ARN=replace-with-worker-instance-profile-arn

# Set to "true" to make the dashboard's Process button run the worker image locally via Podman on your own GPU instead
# of launching a real EC2 spot instance. Requires the image already built as splat-worker:dev. The WORKER_AMI_ID block
# above is unused on this path. Read by web/lib/server/ec2Launcher.ts, not env.ts. See "Triggering the worker from pnpm
# dev" in RUNBOOK.md.
WORKER_LOCAL_LAUNCH=false

# Abuse protection — all optional, defaults shown.
RATE_LIMIT_IP_PER_HOUR=5
RATE_LIMIT_USER_PER_DAY=3
GLOBAL_MAX_JOBS_PER_DAY=20
MIN_PHOTOS_PER_SPLAT=20
EOF
}
