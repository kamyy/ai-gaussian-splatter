#!/usr/bin/env bash
# Shows or changes the runtime settings the deployed web service reads, such as the processing switch and usage limits.
#
# Each setting is an SSM Parameter Store parameter that infra/settings.tf creates. The web service reads it with a
# one-minute cache (web/lib/server/runtimeSettings.ts), so a change takes effect within a minute and needs no deploy.
# The checks below are tighter than the ones web/lib/server/runtimeSettings.ts applies. Integers stop at 1000000 here.
# The web parser allows up to Number.MAX_SAFE_INTEGER. showcase-clerk-user-id must match user_ followed by letters and
# digits, or none. parseShowcase accepts any other string. A value the web parser rejects falls back to the setting's
# default and turns processing off.

set -euo pipefail

usage() {
  echo "Usage: scripts/prod/ssm.sh             Prints every runtime setting and its current value."
  echo "       scripts/prod/ssm.sh NAME VALUE  Sets one runtime setting, after asking. Does nothing if it's VALUE."
  echo
  echo "NAME and its accepted VALUEs:"
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
  echo "Needs aws login as an admin of the deployed account, and gh login."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi
if [[ $# -ne 0 && $# -ne 2 ]]; then
  usage >&2
  exit 1
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/aws.sh"
source "$ROOT/scripts/lib/confirm.sh"
source "$ROOT/scripts/lib/github.sh"
source "$ROOT/scripts/lib/terraform.sh"

# The same path as local.settings_path in infra/locals.tf. It never changes, so it isn't scraped from there.
SETTINGS_PATH=/ai-gaussian-splatter/settings
REGION=$(tf_get_aws_region)

# Succeeds when value is a whole number from min to max.
integer_in() {
  local value=$1 min=$2 max=$3
  [[ $value =~ ^[0-9]+$ ]] && ((10#$value >= min && 10#$value <= max))
}

# Prints what a setting accepts, and succeeds only when the value is one of those. Prints nothing for a name that isn't
# a setting.
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

show_settings() {
  local settings name value
  settings=$(aws ssm get-parameters-by-path --region "$REGION" --path "$SETTINGS_PATH" \
    --query 'Parameters[].[Name, Value]' --output text)
  if [[ -z $settings ]]; then
    echo "No runtime settings under $SETTINGS_PATH. The deploy job creates them on its first run." >&2
    exit 1
  fi

  echo
  while IFS=$'\t' read -r name value; do
    printf '  %-28s %s\n' "${name#"$SETTINGS_PATH"/}" "$value"
  done <<<"$settings"
}

set_setting() {
  local name=$1 value=$2 valid_values parameter current

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

  parameter=$SETTINGS_PATH/$name
  # Terraform creates every setting, so a missing one means the stack isn't deployed. put-parameter would otherwise
  # create a parameter Terraform doesn't know about.
  if ! current=$(aws ssm get-parameter --region "$REGION" --name "$parameter" \
    --query Parameter.Value --output text); then
    echo "Could not read $parameter. The deploy job creates it on its first run." >&2
    exit 1
  fi

  if [[ $current == "$value" ]]; then
    echo "$name is already $value."
    return
  fi

  confirm "Change $name from $current to $value?"
  aws ssm put-parameter --region "$REGION" --name "$parameter" --value "$value" --overwrite >/dev/null
  echo "$name is now $value. The web service picks it up within a minute."
}

if [[ $# -eq 0 ]]; then
  aws_require_login
  gh_require_login
  gh_require_aws_deploy_account
  show_settings
else
  name=$1
  value=$2
  set_setting "$name" "$value"
fi
