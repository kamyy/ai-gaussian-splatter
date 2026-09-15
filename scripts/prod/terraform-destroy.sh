#!/usr/bin/env bash
# Destroys everything in infra/'s state. Refuses while the deploy job is on in origin/main, because the next push to
# main would find an empty state and deploy the whole stack again.

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/require-aws-login.sh"
source "$ROOT/scripts/lib/confirm.sh"
source "$ROOT/scripts/lib/github.sh"
source "$ROOT/scripts/lib/terraform.sh"

git fetch --quiet origin main
CI_WORKFLOW=$(git show origin/main:.github/workflows/ci.yml)
if [[ $CI_WORKFLOW != *'if: false &&'* ]]; then
  echo "The deploy job is still on in origin/main. Land if: false && ... in .github/workflows/ci.yml first." >&2
  exit 1
fi

require_aws_login
require_gh_login
require_aws_deploy_account

confirm "Destroy every resource in infra/'s state in account $AWS_ACCOUNT_ID, data buckets and database included?"

TERRAFORM=$(tf_bin)
load_tf_vars
tf_init
"$TERRAFORM" -chdir="$ROOT/infra" destroy
