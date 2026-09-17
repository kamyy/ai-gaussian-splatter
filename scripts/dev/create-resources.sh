#!/usr/bin/env bash
# Creates web/.env from web/.env.example when it's missing, then the uploads and splats buckets it names and an IAM user
# named from local.project_tag with -dev appended, scoped to just those two buckets. Writes the user's access key into
# web/.env when it creates one. Safe to re-run.
# Existing buckets and the existing user are kept, and their CORS rules, tags, and policy are rewritten.

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/aws.sh"
source "$ROOT/scripts/lib/confirm.sh"
source "$ROOT/scripts/lib/env.sh"
source "$ROOT/scripts/lib/terraform.sh"

PROJECT_TAG=$(tf_get_local project_tag)
DEV_USER=${PROJECT_TAG}-dev

aws_require_login

# The buckets and the region are whatever web/.env names, so the file is created first. A new one is seeded from
# var.aws_region's default, and an existing one keeps whatever region it already holds, because that is the region
# web/lib/server/env.ts signs the app's upload URLs for.
env_create_file "$ROOT/web/.env" "$AWS_ACCOUNT_ID" "$(tf_get_aws_region)"
UPLOADS=$(env_get "$ROOT/web/.env" UPLOADS_BUCKET)
SPLATS=$(env_get "$ROOT/web/.env" SPLATS_BUCKET)
REGION=$(env_get "$ROOT/web/.env" AWS_REGION)

confirm "Create or update the $UPLOADS and $SPLATS buckets and the $DEV_USER IAM user in $REGION, account $AWS_ACCOUNT_ID?"

# us-east-1 is the one region create-bucket rejects a LocationConstraint for, because it is the API's own default.
CREATE_BUCKET_ARGS=()
if [[ $REGION != us-east-1 ]]; then
  CREATE_BUCKET_ARGS=(--create-bucket-configuration "LocationConstraint=$REGION")
fi

for bucket in "$UPLOADS" "$SPLATS"; do
  if aws s3api head-bucket --bucket "$bucket" --region "$REGION" 2>/dev/null; then
    echo "Bucket $bucket already exists. Keeping it and rewriting its tags."
  else
    aws s3api create-bucket --bucket "$bucket" --region "$REGION" "${CREATE_BUCKET_ARGS[@]}" >/dev/null
    echo "Created bucket $bucket."
  fi
  aws s3api put-bucket-tagging --bucket "$bucket" --region "$REGION" \
    --tagging "{\"TagSet\":[{\"Key\":\"Project\",\"Value\":\"$PROJECT_TAG\"}]}"
done

# Without these rules the browser blocks both a cross-origin GET and PUT. The presigned URL is valid, so the failure
# only shows up in the browser console, which distinguishes a CORS-rule 403 from an IAM-policy 403. localhost:3000 is
# `pnpm dev` and localhost:8000 is scripts/dev/run-web-container.sh.
aws s3api put-bucket-cors --bucket "$UPLOADS" --region "$REGION" --cors-configuration '{
  "CORSRules": [{"AllowedMethods": ["PUT"],
                 "AllowedOrigins": ["http://localhost:3000", "http://localhost:8000"],
                 "AllowedHeaders": ["*"]}]
}'
aws s3api put-bucket-cors --bucket "$SPLATS" --region "$REGION" --cors-configuration '{
  "CORSRules": [{"AllowedMethods": ["GET", "HEAD"],
                 "AllowedOrigins": ["http://localhost:3000", "http://localhost:8000"],
                 "AllowedHeaders": ["*"]}]
}'

if aws iam get-user --user-name "$DEV_USER" >/dev/null 2>&1; then
  echo "IAM user $DEV_USER already exists. Keeping it and rewriting its policy."
else
  aws iam create-user --user-name "$DEV_USER" >/dev/null
  echo "Created IAM user $DEV_USER."
fi

aws iam tag-user --user-name "$DEV_USER" --tags "Key=Project,Value=$PROJECT_TAG"
aws iam put-user-policy --user-name "$DEV_USER" \
  --policy-name dev-buckets --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": [\"s3:PutObject\", \"s3:GetObject\", \"s3:DeleteObject\", \"s3:ListBucket\"],
      \"Resource\": [
        \"arn:aws:s3:::$UPLOADS\", \"arn:aws:s3:::$UPLOADS/*\",
        \"arn:aws:s3:::$SPLATS\", \"arn:aws:s3:::$SPLATS/*\"
      ]
    }]
  }"

# Only a user with no key gets one, so a re-run never mints a second. That also covers a run that stopped between
# creating the user and creating its key.
KEY_COUNT=$(aws iam list-access-keys --user-name "$DEV_USER" --query 'length(AccessKeyMetadata)' --output text)
if [[ $KEY_COUNT == 0 ]]; then
  keys=$(aws iam create-access-key --user-name "$DEV_USER" \
    --query 'AccessKey.[AccessKeyId, SecretAccessKey]' --output text)
  read -r key_id secret <<<"$keys"
  # A web/.env that already existed keeps its own mode, so it's locked down before the secret goes in.
  chmod 600 "$ROOT/web/.env"
  env_set "$ROOT/web/.env" AWS_ACCESS_KEY_ID "$key_id"
  env_set "$ROOT/web/.env" AWS_SECRET_ACCESS_KEY "$secret"
  echo "Created an access key for $DEV_USER and wrote it into web/.env."
elif grep -q '^AWS_ACCESS_KEY_ID=replace-with-dev-user-key$' "$ROOT/web/.env"; then
  echo "$DEV_USER already has an access key, but web/.env still holds the placeholder pair." >&2
  echo "AWS shows a secret only once, so this script can't fill it in." >&2
  echo "Copy the pair from another checkout's web/.env, or delete the key (aws iam delete-access-key) and rerun." >&2
else
  echo "$DEV_USER already has an access key, so none was created and web/.env keeps the key it has."
  echo "AWS shows a secret only once. If it's lost, delete the key (aws iam delete-access-key) and run this again."
fi

if grep -q '^CLERK_SECRET_KEY=$' "$ROOT/web/.env"; then
  echo "Fill in NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY in web/.env."
fi
