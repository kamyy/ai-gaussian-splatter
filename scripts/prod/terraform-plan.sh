#!/usr/bin/env bash
# Previews what the deploy job would change in AWS.
#
# Runs terraform plan against the deployed account. The repository variables match the deploy job, except the image
# tags. TF_VAR_web_image_tag comes from the running service. TF_VAR_migrate_image_tag is left unset, so it falls back
# to that tag.

set -euo pipefail

usage() {
  echo "Usage: scripts/prod/terraform-plan.sh [terraform-plan-args...]"
  echo
  echo "Previews what the deploy job would change. Image tags come from the running service. Other variables match"
  echo "the deploy job. Extra arguments go to terraform plan."
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
