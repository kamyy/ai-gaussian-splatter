# shellcheck shell=bash
# Not meant to be run directly.

# Fails fast when the GitHub CLI has no working login. Without it, a failed gh call looks the same as an unset
# repository variable.
gh_require_login() {
  if ! gh auth status --active --hostname github.com >/dev/null 2>&1; then
    echo "Not signed in to the GitHub CLI. Run: gh auth login" >&2
    exit 1
  fi
}

# Prints a GitHub repository variable, or exits naming it when it's unset. The second argument replaces the
# remediation line, for a variable scripts/prod/set-gh-repo-variables.sh doesn't set.
gh_get_repo_var() {
  local repo_var=$1 repo_val
  local remediation=${2:-Run scripts/prod/set-gh-repo-variables.sh.}
  if ! repo_val=$(gh variable get "$repo_var") || [[ -z $repo_val ]]; then
    echo "GitHub repository variable $repo_var is not set. $remediation" >&2
    exit 1
  fi

  printf '%s\n' "$repo_val"
}

# Exits unless the signed-in AWS account is the one the AWS_ACCOUNT_ID repository variable names, which is the account
# the deploy job targets. Call it after aws_require_login from scripts/lib/aws.sh, which sets
# AWS_ACCOUNT_ID.
gh_require_aws_deploy_account() {
  local gh_repo_aws_account_id
  gh_repo_aws_account_id=$(gh_get_repo_var AWS_ACCOUNT_ID)

  if [[ $gh_repo_aws_account_id != "$AWS_ACCOUNT_ID" ]]; then
    echo "Signed in to account $AWS_ACCOUNT_ID," \
      "but GitHub repository variable AWS_ACCOUNT_ID is $gh_repo_aws_account_id." >&2
    exit 1
  fi
}

# Prints the status of an unfinished ci.yml run on main, or nothing when every run has finished. Only a run on main
# reaches the deploy job in .github/workflows/ci.yml, so a run on another branch is not worth reporting.
gh_get_running_ci_status() {
  local status count
  for status in in_progress queued waiting requested pending; do
    count=$(gh run list --workflow=ci.yml --branch main --status "$status" --limit 1 --json databaseId --jq 'length')
    if [[ $count != 0 ]]; then
      printf '%s\n' "$status"
      return
    fi
  done
}

# Exits while a ci.yml run on main is unfinished. scripts/prod/set-deploy-enabled.sh calls it because a run whose
# capture-deploy-enabled job has not been dispatched yet still reads DEPLOY_ENABLED live, so a write would reach it.
# scripts/prod/terraform-destroy.sh calls it because a run that captured true deploys into the state it just emptied.
gh_require_no_ci() {
  local status
  status=$(gh_get_running_ci_status)
  if [[ -n $status ]]; then
    echo "A CI run on main is still ${status}. Wait for it to finish." >&2
    gh run list --workflow=ci.yml --branch main --status "$status" >&2
    exit 1
  fi
}
