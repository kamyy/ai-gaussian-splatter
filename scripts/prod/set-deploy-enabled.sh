#!/usr/bin/env bash
# scripts/prod/set-gh-repo-variables.sh leaves this variable alone. Safe to re-run. A value that already matches is a
# no-op.

set -euo pipefail

usage() {
  echo "Usage: scripts/prod/set-deploy-enabled.sh true|false"
  echo
  echo "Sets the DEPLOY_ENABLED GitHub repository variable to true or false."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/confirm.sh"
source "$ROOT/scripts/lib/github.sh"

wanted=${1-}
if [[ $# -ne 1 || ( "$wanted" != true && "$wanted" != false ) ]]; then
  usage >&2
  exit 1
fi

gh_require_login

# gh variable get reports an unset variable and a repository it cannot read with the same "was not found" message, so
# a failed read would pass as unset here. gh variable list separates the two by exiting nonzero only on a real failure.
if ! current=$(gh variable list --json name,value --jq '.[] | select(.name == "DEPLOY_ENABLED") | .value'); then
  echo "Could not read this GitHub repository's variables." >&2
  exit 1
fi

if [[ ${current,,} == "$wanted" ]]; then
  echo "GitHub repository variable DEPLOY_ENABLED is already $wanted."
  exit 0
fi

if [[ $wanted == true ]]; then
  # Read from the API rather than origin/main, which is only as fresh as the last fetch. Fetching here would also
  # update a remote-tracking ref for a prompt the operator may still decline.
  main_sha=$(gh api "repos/{owner}/{repo}/commits/main" --jq '.sha[:7]')
  echo "The next push to main that is not only .md files or LICENSE will deploy."
  echo "Current main on GitHub: $main_sha"
  confirm "Turn the deploy job on?"
else
  confirm "Turn the deploy job off?"
fi

# Checked here rather than earlier, so the gap between the check and the write stays one API round-trip. A run whose
# capture-deploy-enabled job has not reached a runner yet still reads this variable live.
gh_require_no_in_progress_ci

gh variable set DEPLOY_ENABLED --body "$wanted"
echo "GitHub repository variable DEPLOY_ENABLED is now $wanted."
