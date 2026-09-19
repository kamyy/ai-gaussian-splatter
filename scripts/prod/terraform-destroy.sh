#!/usr/bin/env bash
# Destroys everything in infra/'s state. Refuses while DEPLOY_ENABLED is true, because the next push to main would
# find an empty state and deploy the whole stack again. An unreadable variable is refused too, rather than treated as
# off. An unfinished CI run on main is refused too, because that run may still deploy after destroy.

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/aws.sh"
source "$ROOT/scripts/lib/confirm.sh"
source "$ROOT/scripts/lib/github.sh"
source "$ROOT/scripts/lib/terraform.sh"

aws_require_login
gh_require_login

deploy_enabled=$(gh_get_repo_var DEPLOY_ENABLED "Run: scripts/prod/set-deploy-enabled.sh false")
# Lowercased first, because a GitHub Actions `==` comparison ignores case. True and TRUE arm the deploy job in
# .github/workflows/ci.yml just as true does.
if [[ ${deploy_enabled,,} == true ]]; then
  echo "The deploy job is still on. Run: scripts/prod/set-deploy-enabled.sh false" >&2
  exit 1
fi

gh_require_no_in_progress_ci
gh_require_aws_deploy_account

confirm "Destroy every resource in infra/'s state in account $AWS_ACCOUNT_ID, data buckets and database included?"

TERRAFORM=$(tf_get_bin)
tf_export_vars
tf_init
"$TERRAFORM" -chdir="$ROOT/infra" destroy
