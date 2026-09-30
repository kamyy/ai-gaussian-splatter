#!/usr/bin/env bash
# Picks the account whose splats the landing page shows as examples.
#
# Sets the SHOWCASE_CLERK_USER_ID GitHub repository variable to a user ID from the production Clerk instance, or deletes
# it so the landing page shows no examples. The deploy job passes the variable to the web service, so the change takes
# effect on the next deploy.

# scripts/prod/set-gh-repo-variables.sh leaves this variable alone, because the showcase account can only be created
# once the app is live. Safe to re-run. A value that already matches is a no-op.

set -euo pipefail

usage() {
  echo "Usage: scripts/prod/set-showcase-user.sh user_...|--clear"
  echo
  echo "Sets the SHOWCASE_CLERK_USER_ID GitHub repository variable to a Clerk user ID, or deletes it with --clear."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/confirm.sh"
source "$ROOT/scripts/lib/github.sh"

wanted=${1-}
if [[ $# -ne 1 ]]; then
  usage >&2
  exit 1
fi

# Catches a pasted email address, username or dashboard URL, which would otherwise deploy green and match no account.
if [[ $wanted != --clear && ! $wanted =~ ^user_[A-Za-z0-9]+$ ]]; then
  echo "$wanted is not a Clerk user ID. Copy the user_... ID from the production instance's Users page." >&2
  exit 1
fi

gh_require_login

# gh variable get reports an unset variable and a repository it cannot read with the same "was not found" message, so
# a failed read would pass as unset here. gh variable list separates the two by exiting nonzero only on a real failure.
if ! current=$(gh variable list --json name,value --jq '.[] | select(.name == "SHOWCASE_CLERK_USER_ID") | .value'); then
  echo "Could not read this GitHub repository's variables." >&2
  exit 1
fi

if [[ $wanted == --clear ]]; then
  if [[ -z $current ]]; then
    echo "GitHub repository variable SHOWCASE_CLERK_USER_ID is already unset."
    exit 0
  fi

  echo "Current showcase account: $current"
  confirm "Delete SHOWCASE_CLERK_USER_ID, so the landing page shows no examples?"
  gh variable delete SHOWCASE_CLERK_USER_ID
  echo "GitHub repository variable SHOWCASE_CLERK_USER_ID is deleted."
else
  if [[ $current == "$wanted" ]]; then
    echo "GitHub repository variable SHOWCASE_CLERK_USER_ID is already $wanted."
    exit 0
  fi

  echo "Current showcase account: ${current:-none}"
  confirm "Set SHOWCASE_CLERK_USER_ID to $wanted?"
  gh variable set SHOWCASE_CLERK_USER_ID --body "$wanted"
  echo "GitHub repository variable SHOWCASE_CLERK_USER_ID is now $wanted."
fi

# Printed rather than run, so starting a deploy stays its own decision.
echo
echo "It takes effect on the next deploy. To deploy now without a push, rerun the newest CI run on main:"
echo "  gh run rerun \"\$(gh run list --branch main --workflow ci.yml --limit 1 --json databaseId --jq '.[0].databaseId')\""
