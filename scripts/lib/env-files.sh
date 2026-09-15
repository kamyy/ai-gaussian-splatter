# shellcheck shell=bash
# Sourced by scripts/dev/create-dev-resources.sh, scripts/lib/worker.sh, and scripts/dev/run-web-container.sh.
# web/.env isn't committed, so the template below is the only record of what it holds. Not meant to be run directly.

# Usage: create_env_file <path> <template-function>
#
# Writes the template to the path only when nothing is there yet, so a re-run never replaces values filled in by hand.
# The file is readable only by its owner, because it ends up holding the dev user's secret key.
create_env_file() {
  local file=$1 template=$2
  if [[ -f $file ]]; then
    echo "$file already exists. Keeping it."
    return
  fi

  (umask 077 && "$template" >"$file")
  echo "Created $file."
}

# Usage: set_env_var <path> <name> <value>
#
# Replaces the file's NAME= line, or appends one when there isn't any. The value reaches awk through the environment
# rather than inside an awk or sed expression, because AWS secret keys can contain / and +.
set_env_var() {
  local file=$1 name=$2 value=$3 tmp
  if ! grep -q "^$name=" "$file"; then
    # Without a final newline, the appended line would be glued onto the file's last one.
    if [[ -s $file && -n $(tail -c1 "$file") ]]; then
      printf '\n' >> "$file"
    fi
    printf '%s=%s\n' "$name" "$value" >>"$file"
    return
  fi

  tmp=$(mktemp)
  NAME=$name VALUE=$value awk '
    index($0, ENVIRON["NAME"] "=") == 1 { $0 = ENVIRON["NAME"] "=" ENVIRON["VALUE"] }
    { print }' "$file" >"$tmp"
  # Copied back rather than moved, so the file keeps its own permissions.
  cat "$tmp" >"$file"
  rm -f "$tmp"
}

# Usage: get_env_var <path> <name>
#
# Prints the file's NAME= value, or exits naming the file and variable when it's missing or empty.
get_env_var() {
  local file=$1 name=$2 value
  value=$(grep -oP -m1 "^$name=\K.*" "$file" || true)
  if [[ -z $value ]]; then
    echo "$file has no $name value." >&2
    exit 1
  fi

  printf '%s\n' "$value"
}

web_env_template() {
  cat <<'EOF'
# Local dev config for the web app. scripts/lib/worker.sh also reads its AWS keys, region, and buckets for local worker
# runs. scripts/dev/create-dev-resources.sh writes this file when web/.env is missing, and never replaces an existing
# one. Fill in the Clerk keys. Read by web/lib/server/env.ts unless noted otherwise.

# The two dev buckets from "Dev AWS resources" in RUNBOOK.md.
UPLOADS_BUCKET=ai-gaussian-splatter-dev-uploads
SPLATS_BUCKET=ai-gaussian-splatter-dev-splats

# The dev IAM user scoped to those two buckets. scripts/dev/create-dev-resources.sh writes its key pair here when it
# creates the user's access key. Kept here rather than in ~/.aws/credentials because `next dev` loads this file, and
# because the SDK's env provider tests these for truthiness: an empty value counts as absent and the chain falls through
# to ~/.aws/credentials, signing upload URLs with whatever profile is configured there. The placeholders are non-empty
# so an unedited .env fails with a 403 instead of quietly using an admin profile.
AWS_ACCESS_KEY_ID=replace-with-dev-user-key
AWS_SECRET_ACCESS_KEY=replace-with-dev-user-secret

# The AWS region the buckets and credentials above are used against. web/lib/server/env.ts reads it and hands it to
# every S3 and EC2 client explicitly. The worker gets the same value as AWS_DEFAULT_REGION (scripts/lib/worker.sh,
# web/lib/server/ec2Launcher.ts), because boto3 reads only that name and the AWS SDK for JavaScript reads only this one.
AWS_REGION=us-west-2

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
