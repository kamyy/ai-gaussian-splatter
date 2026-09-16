#!/usr/bin/env bash
# Resolves every repository variable .github/workflows/deploy.yml reads and sets them with `gh variable set`.
# scripts/prod/terraform-plan.sh and scripts/prod/terraform-destroy.sh read the same variables back. Run it after
# scripts/prod/create-account-prereqs.sh, since it looks up the Clerk secret that script creates. Safe to re-run. Each
# prompt defaults to the variable's current value.

# shellcheck disable=SC2034 # Each value is read back through ${!name} at the end.
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/require-aws-login.sh"
source "$ROOT/scripts/lib/confirm.sh"
source "$ROOT/scripts/lib/github.sh"
source "$ROOT/scripts/lib/terraform.sh"

REGION=$(tf_aws_region)

# Prints a repository variable's current value, or nothing when it's unset.
current_repo_var() {
  gh variable get "$1" 2>/dev/null || true
}

# Usage: ask <prompt> <default>
#
# Prints the answer. An empty answer takes the default, and an empty result exits.
ask() {
  local reply
  read -rp "$1${2:+ [$2]}: " reply
  reply=${reply:-$2}
  if [[ -z $reply ]]; then
    echo "A value is required." >&2
    exit 1
  fi
  printf '%s\n' "$reply"
}

require_aws_login
require_gh_login

DOMAIN_ZONE_NAME=$(ask "Public DNS zone the app is served from" "$(current_repo_var DOMAIN_ZONE_NAME)")
# A zone name copied from the Route 53 console arrives as "example.com.", and the lookup below matches the API's own
# lowercase spelling exactly. var.domain_zone_name's validation rejects both forms, so they are normalized here rather
# than left to fail at the first apply.
DOMAIN_ZONE_NAME=${DOMAIN_ZONE_NAME%.}
DOMAIN_ZONE_NAME=${DOMAIN_ZONE_NAME,,}
# The API returns the ID as /hostedzone/<id>, and var.hosted_zone_id takes the bare ID.
HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$DOMAIN_ZONE_NAME" \
  --query "HostedZones[?Name=='$DOMAIN_ZONE_NAME.' && Config.PrivateZone==\`false\`].Id | [0]" \
  --output text | cut -d/ -f3)
if [[ $HOSTED_ZONE_ID != Z* ]]; then
  echo "No public hosted zone named $DOMAIN_ZONE_NAME in account $AWS_ACCOUNT_ID." >&2
  exit 1
fi

if ! CLERK_SECRET_KEY_ARN=$(aws secretsmanager describe-secret --region "$REGION" \
  --secret-id ai-gaussian-splatter/clerk-secret-key --query ARN --output text); then
  echo "Create the Clerk secret with scripts/prod/create-account-prereqs.sh first." >&2
  exit 1
fi

ALERT_EMAIL=$(ask "Budget alert email" "$(current_repo_var ALERT_EMAIL)")

CLERK_PUBLISHABLE_KEY=$(ask "Clerk publishable key (pk_live_...)" "$(current_repo_var CLERK_PUBLISHABLE_KEY)")
if [[ $CLERK_PUBLISHABLE_KEY != pk_live_* ]]; then
  echo "That isn't the production instance's pk_live_* key. A pk_test_* key doesn't match the live secret key." >&2
  exit 1
fi

echo "Newest Deep Learning Base GPU AMIs:"
AMIS=$(aws ec2 describe-images --region "$REGION" --owners amazon \
  --filters "Name=name,Values=Deep Learning Base*GPU AMI*Ubuntu*" \
  "Name=architecture,Values=x86_64" \
  "Name=state,Values=available" \
  --query 'reverse(sort_by(Images,&CreationDate))[:5].[ImageId,CreationDate,Name]' \
  --output text)
printf '%s\n' "$AMIS"
CURRENT_AMI=$(current_repo_var WORKER_AMI_ID)
WORKER_AMI_ID=$(ask "Worker AMI" "${CURRENT_AMI:-${AMIS%%$'\t'*}}")

# scripts/prod/push-worker-image.sh owns this once a worker image exists. Until then any SHA-shaped value passes
# validation.
WORKER_IMAGE_TAG=$(current_repo_var WORKER_IMAGE_TAG)
WORKER_IMAGE_TAG=${WORKER_IMAGE_TAG:-$(git rev-parse --short HEAD)}

# DEPLOY_ENABLED is deliberately absent. Going live is a separate `gh variable set` (RUNBOOK.md).
NAMES=(AWS_ACCOUNT_ID DOMAIN_ZONE_NAME HOSTED_ZONE_ID CLERK_SECRET_KEY_ARN ALERT_EMAIL WORKER_AMI_ID
  WORKER_IMAGE_TAG CLERK_PUBLISHABLE_KEY)
echo "The app will serve from https://$(tf_app_hostname "$DOMAIN_ZONE_NAME")."
echo
for name in "${NAMES[@]}"; do
  printf '  %-22s %s\n' "$name" "${!name}"
done
confirm "Set these repository variables on $(gh repo view --json nameWithOwner --jq .nameWithOwner)?"

for name in "${NAMES[@]}"; do
  gh variable set "$name" --body "${!name}"
done

# .github/workflows/deploy.yml builds the app's origin from local.app_hostname, so an APP_PUBLIC_URL repository
# variable feeds nothing. Removed rather than left in the list reading as live configuration.
if [[ -n $(current_repo_var APP_PUBLIC_URL) ]]; then
  gh variable delete APP_PUBLIC_URL
  echo "Deleted APP_PUBLIC_URL, which nothing reads."
fi
