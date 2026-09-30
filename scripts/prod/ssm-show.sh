#!/usr/bin/env bash
# Prints the runtime settings the deployed web service reads.
#
# Each setting is an SSM Parameter Store parameter that infra/settings.tf creates and web/lib/server/runtimeSettings.ts
# reads with a one-minute cache. scripts/prod/ssm-set.sh changes one.

set -euo pipefail

usage() {
  echo "Usage: scripts/prod/ssm-show.sh"
  echo
  echo "Prints every runtime setting in the deployed account and its current value."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/aws.sh"
source "$ROOT/scripts/lib/github.sh"
source "$ROOT/scripts/lib/terraform.sh"

# The same path as local.settings_path in infra/locals.tf. It never changes, so it isn't scraped from there.
SETTINGS_PATH=/ai-gaussian-splatter/settings

aws_require_login
gh_require_login
gh_require_aws_deploy_account

REGION=$(tf_get_aws_region)
SETTINGS=$(aws ssm get-parameters-by-path --region "$REGION" --path "$SETTINGS_PATH" \
  --query 'Parameters[].[Name, Value]' --output text)
if [[ -z $SETTINGS ]]; then
  echo "No runtime settings under $SETTINGS_PATH. The deploy job creates them on its first run." >&2
  exit 1
fi

echo
while IFS=$'\t' read -r name value; do
  printf '  %-28s %s\n' "${name#"$SETTINGS_PATH"/}" "$value"
done <<<"$SETTINGS"
