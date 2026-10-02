# shellcheck shell=bash
# Shared helpers for scripts that call the GitHub CLI.
#
# Sourced by other scripts, not run directly. They check the gh login, read repository variables, and check the state of
# CI runs.

# Fails fast when the GitHub CLI has no working login. Without it, a failed gh call looks the same as an unset
# repository variable.
gh_require_login() {
  if ! gh auth status --active --hostname github.com >/dev/null 2>&1; then
    echo "Not signed in to the GitHub CLI. Run: gh auth login" >&2
    exit 1
  fi
}

# Prints a GitHub repository variable, or exits naming it when it's unset. The second argument replaces the
# remediation line, for a variable scripts/prod/bootstrap.sh gh-vars doesn't set.
gh_get_repo_var() {
  local repo_var=$1 repo_val
  local remediation=${2:-Run scripts/prod/bootstrap.sh gh-vars.}
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

# Exits while a ci.yml run on main is unfinished. Call it before writing DEPLOY_ENABLED, because a run whose
# capture-deploy-enabled job has not been dispatched yet still reads the variable live, so the write would reach it.
# Call it before a destroy too, because a run that captured true would deploy into the state the destroy empties.
gh_require_no_in_progress_ci() {
  local status
  status=$(gh_get_running_ci_status)
  if [[ -n $status ]]; then
    echo "A CI run on main is still ${status}. Wait for it to finish." >&2
    gh run list --workflow=ci.yml --branch main --status "$status" >&2
    exit 1
  fi
}

# Prints the DEPLOY_ENABLED repository variable lowercased, or nothing when it's unset. Lowercased because a GitHub
# Actions `==` comparison ignores case, so True and TRUE arm the deploy job in .github/workflows/ci.yml just as true
# does.
gh_get_deploy_enabled() {
  local deploy_enabled
  deploy_enabled=$(gh variable get DEPLOY_ENABLED 2>/dev/null || true)
  printf '%s\n' "${deploy_enabled,,}"
}

# Runs .github/workflows/ci.yml on main by hand and waits for it to finish, so its deploy job applies whatever
# repository variables were just set. Call it only while DEPLOY_ENABLED is true, since the run otherwise skips its
# deploy job. The run is found by the URL gh prints when it starts one. Picking the newest run from `gh run list`
# instead could pick up a push that started at the same moment.
gh_run_deploy() {
  local output url
  if ! output=$(gh workflow run ci.yml --ref main 2>&1); then
    echo "$output" >&2
    exit 1
  fi

  url=$(grep -oE 'https://github\.com/[^[:space:]]+/actions/runs/[0-9]+' <<<"$output" || true)
  if [[ -z $url ]]; then
    echo "Started ci.yml on main, but gh printed no run URL to follow. Find the run here:" >&2
    gh repo view --json url --jq '.url + "/actions/workflows/ci.yml"' >&2
    exit 1
  fi

  echo "Deploying through $url"
  if ! gh run watch "${url##*/}" --compact --exit-status; then
    echo "The run failed: $url" >&2
    exit 1
  fi
  echo "The deploy finished."
}
