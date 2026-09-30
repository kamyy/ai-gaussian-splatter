#!/usr/bin/env bash
# Changes one runtime setting in the deployed account, such as switching processing off or raising a limit.
#
# Each setting is an SSM Parameter Store parameter that infra/settings.tf creates. The web service reads it with a
# one-minute cache (web/lib/server/runtimeSettings.ts), so a change takes effect within a minute and needs no deploy.
# The checks below match the ones the web service applies. A value that fails them there falls back to the setting's
# default, so catching it here is what tells you.

set -euo pipefail

usage() {
  echo "Usage: scripts/prod/ssm-set.sh NAME VALUE"
  echo
  echo "Sets one runtime setting. NAME and its accepted VALUEs:"
  echo "  processing-enabled           true or false. false pauses reconstruct and train site-wide."
  echo "  max-jobs-per-day             GPU instances the whole site may launch per UTC day, 0 or more"
  echo "  uploads-per-ip-per-hour      upload batches per IP address per hour, 1 or more"
  echo "  uploads-per-user-per-day     upload batches per account per UTC day, 1 or more"
  echo "  min-photos-per-splat         3 to 100"
  echo "  worker-max-lifetime-minutes  5 to 240. Applies to instances launched after the change."
  echo "  reconstruct-instance-type    g4dn.xlarge, g5.xlarge or g6.xlarge"
  echo "  train-instance-type          g5.xlarge, g6.xlarge or g6e.xlarge"
  echo "  training-iterations          1000 to 30000"
  echo "  showcase-clerk-user-id       a production Clerk user ID (user_...), or none"
  echo
  echo "scripts/prod/ssm-show.sh prints the current values."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/aws.sh"
source "$ROOT/scripts/lib/confirm.sh"
source "$ROOT/scripts/lib/github.sh"
source "$ROOT/scripts/lib/terraform.sh"

# The same path as local.settings_path in infra/locals.tf. It never changes, so it isn't scraped from there.
SETTINGS_PATH=/ai-gaussian-splatter/settings

# Succeeds when value is a whole number from min to max.
integer_in() {
  local value=$1 min=$2 max=$3
  [[ $value =~ ^[0-9]+$ ]] && ((10#$value >= min && 10#$value <= max))
}

# Prints what a setting accepts, and succeeds only when the value is one of those. Prints nothing for a name that isn't a
# setting.
check_value() {
  local name=$1 value=$2
  case $name in
    processing-enabled)
      echo "true or false"
      [[ $value == true || $value == false ]]
      ;;
    max-jobs-per-day)
      echo "a whole number, 0 or more"
      integer_in "$value" 0 1000000
      ;;
    uploads-per-ip-per-hour | uploads-per-user-per-day)
      echo "a whole number, 1 or more"
      integer_in "$value" 1 1000000
      ;;
    min-photos-per-splat)
      echo "a whole number from 3 to 100"
      integer_in "$value" 3 100
      ;;
    worker-max-lifetime-minutes)
      echo "a whole number from 5 to 240"
      integer_in "$value" 5 240
      ;;
    reconstruct-instance-type)
      echo "g4dn.xlarge, g5.xlarge or g6.xlarge"
      [[ $value =~ ^(g4dn|g5|g6)\.xlarge$ ]]
      ;;
    train-instance-type)
      echo "g5.xlarge, g6.xlarge or g6e.xlarge"
      [[ $value =~ ^(g5|g6|g6e)\.xlarge$ ]]
      ;;
    training-iterations)
      echo "a whole number from 1000 to 30000"
      integer_in "$value" 1000 30000
      ;;
    # Catches a pasted email address, username or dashboard URL, which would otherwise match no account.
    showcase-clerk-user-id)
      echo "a user_... ID or none"
      [[ $value == none || $value =~ ^user_[A-Za-z0-9]+$ ]]
      ;;
    *)
      return 1
      ;;
  esac
}

if [[ $# -ne 2 ]]; then
  usage >&2
  exit 1
fi

name=$1
value=$2

if ! valid_values=$(check_value "$name" "$value"); then
  if [[ -z $valid_values ]]; then
    echo "$name is not a runtime setting." >&2
  else
    echo "$name must be $valid_values, not $value." >&2
  fi
  exit 1
fi

aws_require_login
gh_require_login
gh_require_aws_deploy_account

REGION=$(tf_get_aws_region)
PARAMETER=$SETTINGS_PATH/$name

# Terraform creates every setting, so a missing one means the stack isn't deployed. put-parameter would otherwise create
# a parameter Terraform doesn't know about.
if ! current=$(aws ssm get-parameter --region "$REGION" --name "$PARAMETER" --query Parameter.Value --output text); then
  echo "Could not read $PARAMETER. The deploy job creates it on its first run." >&2
  exit 1
fi

if [[ $current == "$value" ]]; then
  echo "$name is already $value."
  exit 0
fi

confirm "Change $name from $current to $value?"
aws ssm put-parameter --region "$REGION" --name "$PARAMETER" --value "$value" --overwrite >/dev/null
echo "$name is now $value. The web service picks it up within a minute."
