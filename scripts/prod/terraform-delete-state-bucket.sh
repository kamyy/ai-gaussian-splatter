#!/usr/bin/env bash
# Empties and deletes the Terraform state bucket. Run it only after scripts/prod/terraform-destroy.sh has finished with
# it.

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/aws.sh"
source "$ROOT/scripts/lib/confirm.sh"
source "$ROOT/scripts/lib/github.sh"
source "$ROOT/scripts/lib/terraform.sh"

REGION=$(tf_get_aws_region)

aws_require_login
gh_require_login
gh_require_aws_deploy_account
BUCKET="ai-gaussian-splatter-tfstate-$AWS_ACCOUNT_ID"
TERRAFORM=$(tf_get_bin)

# Refuses while the state still tracks anything, for example after a destroy that failed partway. Deleting it then would
# leave those resources with nothing that can remove them, and their fixed names would block the next deploy.
tf_init >/dev/null
REMAINING=$("$TERRAFORM" -chdir="$ROOT/infra" state list)
if [[ -n $REMAINING ]]; then
  echo "The state in $BUCKET still tracks these resources. Finish scripts/prod/terraform-destroy.sh first." >&2
  while IFS= read -r address; do
    echo "  $address" >&2
  done <<<"$REMAINING"
  exit 1
fi

confirm "Delete $BUCKET and every version of every object in it?"

# Versioning is on, so current objects and old versions both have to go before delete-bucket. delete-objects takes at
# most 1000 keys, but the CLI merges every page of list-object-versions into one result. --no-paginate keeps each
# listing to a single S3 page of at most 1000 versions and delete markers combined, so the loop repeats until a page has
# no keys. --max-items can't replace it, because it counts only Versions and lets delete markers through uncounted.
while :; do
  OBJECTS=$(aws s3api list-object-versions --bucket "$BUCKET" --region "$REGION" --no-paginate \
    --output json --query '{Objects: [Versions[], DeleteMarkers[]][].{Key:Key,VersionId:VersionId}}')
  if [[ $OBJECTS != *'"Key"'* ]]; then
    break
  fi
  # delete-objects exits 0 even when some keys fail, and lists them under Errors. Stopping on them keeps the next
  # listing from returning the same keys forever.
  ERRORS=$(aws s3api delete-objects --bucket "$BUCKET" --region "$REGION" --delete "$OBJECTS" \
    --query 'Errors' --output json)
  if [[ $ERRORS != null && $ERRORS != '[]' ]]; then
    echo "S3 refused to delete some objects in $BUCKET:" >&2
    echo "$ERRORS" >&2
    exit 1
  fi
done

aws s3api delete-bucket --bucket "$BUCKET" --region "$REGION"
echo "Deleted $BUCKET."
