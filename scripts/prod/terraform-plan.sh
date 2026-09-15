#!/usr/bin/env bash
# Previews what the deploy job would change, using the repository variables it applies with. Extra arguments go to
# `terraform plan`.

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/require-aws-login.sh"
source "$ROOT/scripts/lib/github.sh"
source "$ROOT/scripts/lib/terraform.sh"

require_aws_login
require_gh_login
require_aws_deploy_account

TERRAFORM=$(tf_bin)
load_tf_vars
tf_init
"$TERRAFORM" -chdir="$ROOT/infra" plan "$@"
