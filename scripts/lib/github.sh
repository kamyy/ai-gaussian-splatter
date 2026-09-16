# shellcheck shell=bash
# Sourced by the scripts in scripts/prod/ that call the GitHub CLI. Not meant to be run directly.

# Fails fast when the GitHub CLI has no working login. Without it, a failed gh call looks the same as an unset
# repository variable.
require_gh_login() {
  if ! gh auth status --active --hostname github.com >/dev/null 2>&1; then
    echo "Not signed in to the GitHub CLI. Run: gh auth login" >&2
    exit 1
  fi
}

# Prints a GitHub repository variable, or exits naming it when it's unset. The second argument replaces the
# remediation line, for a variable scripts/prod/set-gh-repo-variables.sh doesn't set.
gh_repo_var() {
  local value
  if ! value=$(gh variable get "$1") || [[ -z $value ]]; then
    echo "Repository variable $1 is not set. ${2:-Run scripts/prod/set-gh-repo-variables.sh.}" >&2
    exit 1
  fi

  printf '%s\n' "$value"
}

# Exits unless the signed-in AWS account is the one the AWS_ACCOUNT_ID repository variable names, which is the account
# the deploy job targets. Call it after require_aws_login from scripts/lib/require-aws-login.sh, which sets
# AWS_ACCOUNT_ID.
require_aws_deploy_account() {
  local gh_repo_aws_account_id
  gh_repo_aws_account_id=$(gh_repo_var AWS_ACCOUNT_ID)

  if [[ $gh_repo_aws_account_id != "$AWS_ACCOUNT_ID" ]]; then
    echo "Signed in to account $AWS_ACCOUNT_ID," \
      "but GitHub repository variable AWS_ACCOUNT_ID is $gh_repo_aws_account_id." >&2
    exit 1
  fi
}
