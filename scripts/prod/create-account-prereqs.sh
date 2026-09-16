#!/usr/bin/env bash
# One-time setup `infra/` can't do for itself: the Clerk secret, the Spot service-linked role, and the Terraform state
# bucket. Safe to re-run. Anything that already exists is kept, and the Clerk secret's value is never overwritten.

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/require-aws-login.sh"
source "$ROOT/scripts/lib/confirm.sh"
source "$ROOT/scripts/lib/terraform.sh"

# Reads a secret from the terminal and prints a * per character, so a paste is visible as a mask.
# Backspace removes one character. Ctrl-U clears the line.
read_masked() {
  local prompt=$1 char
  local -n dest=$2
  dest=
  printf '%s' "$prompt"
  # Bracketed paste would otherwise land its escape sequences in the value, one * at a time.
  printf '\e[?2004l'
  while IFS= read -r -s -n1 char; do
    if [[ -z $char ]]; then
      break
    fi
    case $char in
      $'\177' | $'\b')
        if [[ -n $dest ]]; then
          dest=${dest%?}
          printf '\b \b'
        fi
        ;;
      $'\025')
        while [[ -n $dest ]]; do
          dest=${dest%?}
          printf '\b \b'
        done
        ;;
      *)
        dest+=$char
        printf '*'
        ;;
    esac
  done
  echo
}

SECRET_NAME=ai-gaussian-splatter/clerk-secret-key
PROJECT_TAG=$(tf_local_var project_tag)
REGION=$(tf_aws_region)

require_aws_login
BUCKET="ai-gaussian-splatter-tfstate-$AWS_ACCOUNT_ID"

confirm "Create the Clerk secret, the Spot service-linked role, and $BUCKET in $REGION, account $AWS_ACCOUNT_ID?"

# SECRET_STATE ends up as None for a live secret, its deletion date for one scheduled for deletion, or missing. Only
# ResourceNotFoundException means missing. Any other error stops here, rather than prompting for a key that
# create-secret would then refuse.
if ! SECRET_STATE=$(aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_NAME" \
  --query DeletedDate --output text 2>&1); then
  if [[ $SECRET_STATE != *ResourceNotFoundException* ]]; then
    echo "$SECRET_STATE" >&2
    exit 1
  fi
  SECRET_STATE=missing
fi

if [[ $SECRET_STATE == None ]]; then
  echo "$SECRET_NAME already exists, so its value was left alone."
elif [[ $SECRET_STATE != missing ]]; then
  # ECS can't read a secret scheduled for deletion, and create-secret can't reuse the name until the deletion goes
  # through. Restoring it is the only way to keep this name.
  aws secretsmanager restore-secret --region "$REGION" --secret-id "$SECRET_NAME" >/dev/null
  echo "$SECRET_NAME was scheduled for deletion, so it was restored with the value it had before."
else
  read_masked "Clerk secret key (sk_live_...): " CLERK_SECRET_KEY
  if [[ $CLERK_SECRET_KEY != sk_live_* ]]; then
    echo "That isn't a live Clerk secret key." >&2
    exit 1
  fi
  # Piped on stdin, since an argument would show in the process list. printf is a builtin, so it spawns no process of
  # its own. Unlike a here-string, it adds no trailing newline to the stored value.
  SECRET_ARN=$(printf '%s' "$CLERK_SECRET_KEY" | aws secretsmanager create-secret --region "$REGION" \
    --name "$SECRET_NAME" --description "clerk-secret-key" --secret-string file:///dev/stdin --query ARN --output text)
  echo "Created $SECRET_NAME: $SECRET_ARN"
fi

aws secretsmanager tag-resource --region "$REGION" --secret-id "$SECRET_NAME" \
  --tags "Key=Project,Value=$PROJECT_TAG"

# Creating this role a second time fails outright, hence the guard.
if aws iam get-role --role-name AWSServiceRoleForEC2Spot >/dev/null 2>&1; then
  echo "AWSServiceRoleForEC2Spot already exists."
else
  aws iam create-service-linked-role --aws-service-name spot.amazonaws.com >/dev/null
  echo "Created AWSServiceRoleForEC2Spot."
fi

# us-east-1 is the one region create-bucket rejects a LocationConstraint for, because it is the API's own default.
CREATE_BUCKET_ARGS=()
if [[ $REGION != us-east-1 ]]; then
  CREATE_BUCKET_ARGS=(--create-bucket-configuration "LocationConstraint=$REGION")
fi

if aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
  echo "State bucket $BUCKET already exists. Keeping it and reapplying its settings."
else
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" "${CREATE_BUCKET_ARGS[@]}" >/dev/null
  echo "Created state bucket $BUCKET."
fi

aws s3api put-bucket-versioning --bucket "$BUCKET" --region "$REGION" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption --bucket "$BUCKET" --region "$REGION" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws s3api put-public-access-block --bucket "$BUCKET" --region "$REGION" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# Replaces the bucket's whole tag set. This bucket only carries Project.
aws s3api put-bucket-tagging --bucket "$BUCKET" --region "$REGION" \
  --tagging "{\"TagSet\":[{\"Key\":\"Project\",\"Value\":\"$PROJECT_TAG\"}]}"

echo "Account setup done. Next: scripts/prod/configure-ci-role.sh"
