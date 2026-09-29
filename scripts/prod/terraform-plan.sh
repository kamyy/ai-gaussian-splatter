#!/usr/bin/env bash
# Previews what the deploy job would change in AWS.
#
# Runs terraform plan against the deployed account with the same repository variables the deploy job applies with,
# without changing anything.

set -euo pipefail

usage() {
  echo "Usage: scripts/prod/terraform-plan.sh [terraform-plan-args...]"
  echo
  echo "Previews what the deploy job would change, using the repository variables it applies with. Extra arguments go"
  echo "to terraform plan."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/aws.sh"
source "$ROOT/scripts/lib/github.sh"
source "$ROOT/scripts/lib/terraform.sh"

aws_require_login
gh_require_login
gh_require_aws_deploy_account

TERRAFORM=$(tf_get_bin)
tf_export_vars
tf_init
"$TERRAFORM" -chdir="$ROOT/infra" plan "$@"
