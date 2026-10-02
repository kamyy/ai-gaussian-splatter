#!/usr/bin/env bash
# Tears down a deployed AWS account: turns the deploy job off, destroys the stack, deletes the Terraform state bucket,
# then removes what scripts/prod/bootstrap.sh created outside infra/.
#
# The order matters. The deploy job goes off first, or the next push to main would find an empty state and deploy the
# whole stack again. The state bucket goes only once the state in it is empty, or the resources it still tracked would
# have nothing left that can remove them. The repository variables go last, because the destroy and state-bucket steps
# read them. Every step checks what is already gone and skips it, so running the script again after a partial teardown
# picks up where it stopped.

set -euo pipefail

usage() {
  echo "Usage: scripts/prod/teardown.sh [STEP]"
  echo
  echo "With no STEP, runs every step below in order. Each one skips what is already gone, so a re-run is safe."
  echo
  echo "Steps:"
  echo "  disable       Sets DEPLOY_ENABLED to false, so a push to main can't redeploy into the emptied account."
  echo "                Refuses while a CI run on main is unfinished."
  echo "  destroy       Runs terraform destroy on everything in infra/'s state: the S3 buckets and their contents, the"
  echo "                database (no final snapshot), both ECR repositories and their images, and the rest of the"
  echo "                stack. Refuses while DEPLOY_ENABLED is true or a CI run on main is unfinished."
  echo "  state-bucket  Deletes the ai-gaussian-splatter-tfstate-<account> bucket and every version in it. Refuses"
  echo "                while the state still tracks any resource."
  echo "  cleanup       Schedules the Clerk secret ai-gaussian-splatter/clerk-secret-key for deletion (30 days, and"
  echo "                scripts/prod/bootstrap.sh restores it until then), deletes the ai-gaussian-splatter-ci-deploy"
  echo "                role, and deletes the GitHub repository variables. Refuses until the state bucket is gone."
  echo
  echo "Left in place, since each is shared with anything else in the account: AWSServiceRoleForEC2Spot, the GitHub"
  echo "OIDC provider, and the Route 53 hosted zone."
  echo
  echo "Needs aws login as an admin of the deployed account, and gh login with write access to this repository."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

STEP=${1-}
case $STEP in
  "" | disable | destroy | state-bucket | cleanup) ;;
  *)
    usage >&2
    exit 1
    ;;
esac
if [[ $# -gt 1 ]]; then
  usage >&2
  exit 1
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/aws.sh"
source "$ROOT/scripts/lib/confirm.sh"
source "$ROOT/scripts/lib/github.sh"
source "$ROOT/scripts/lib/terraform.sh"

REGION=$(tf_get_aws_region)
SECRET_NAME=ai-gaussian-splatter/clerk-secret-key
ROLE=ai-gaussian-splatter-ci-deploy
# Every variable scripts/prod/bootstrap.sh and scripts/prod/worker-push-image.sh set.
REPO_VARS=(
  ALERT_EMAIL
  AWS_ACCOUNT_ID
  CLERK_PUBLISHABLE_KEY
  CLERK_SECRET_KEY_ARN
  DEPLOY_ENABLED
  DOMAIN_ZONE_NAME
  GA_MEASUREMENT_ID
  HOSTED_ZONE_ID
  WORKER_AMI_ID
  WORKER_IMAGE_TAG
)

# Succeeds when the AWS_ACCOUNT_ID repository variable is set, after checking it names the signed-in account. The
# cleanup step deletes it only once the stack and its state bucket are gone, so an unset one means the destroy and
# state-bucket steps have nothing left to do.
has_deploy_account() {
  if [[ -z $(gh variable get AWS_ACCOUNT_ID 2>/dev/null || true) ]]; then
    return 1
  fi
  gh_require_aws_deploy_account
}

has_state_bucket() {
  aws s3api head-bucket --bucket "ai-gaussian-splatter-tfstate-$AWS_ACCOUNT_ID" --region "$REGION" 2>/dev/null
}

disable_deploys() {
  if [[ $(gh_get_deploy_enabled) != true ]]; then
    echo "disable: the deploy job is already off."
    return
  fi

  confirm "Turn the deploy job off?"
  # Checked here rather than earlier, so the gap between the check and the write stays one API round-trip.
  gh_require_no_in_progress_ci
  gh variable set DEPLOY_ENABLED --body false
  echo "DEPLOY_ENABLED is now false."
}

destroy() {
  local terraform remaining
  if ! has_deploy_account || ! has_state_bucket; then
    # The bucket is looked up in var.aws_region's current default, so an edited default lands here too, while the old
    # stack keeps running in the previous region.
    echo "destroy: there is no Terraform state bucket in $REGION, so nothing to destroy. If var.aws_region's default in"
    echo "infra/variables.tf changed since the deploy, put it back and run this again."
    return
  fi
  if [[ $(gh_get_deploy_enabled) == true ]]; then
    echo "The deploy job is still on. Run: scripts/prod/teardown.sh disable" >&2
    exit 1
  fi
  # A run that captured DEPLOY_ENABLED=true before it was turned off would deploy into the state this empties.
  gh_require_no_in_progress_ci

  terraform=$(tf_get_bin)
  tf_init >/dev/null
  remaining=$("$terraform" -chdir="$ROOT/infra" state list)
  if [[ -z $remaining ]]; then
    echo "destroy: infra/'s state is already empty."
    return
  fi

  confirm "Destroy every resource in infra/'s state in account $AWS_ACCOUNT_ID, data buckets and database included?"
  tf_export_vars
  "$terraform" -chdir="$ROOT/infra" destroy
}

delete_state_bucket() {
  local bucket=ai-gaussian-splatter-tfstate-$AWS_ACCOUNT_ID terraform remaining address objects errors
  if ! has_deploy_account || ! has_state_bucket; then
    echo "state-bucket: $bucket is already gone."
    return
  fi

  # Refuses while the state still tracks anything, for example after a destroy that failed partway. Deleting it then
  # would leave those resources with nothing that can remove them, and their fixed names would block the next deploy.
  terraform=$(tf_get_bin)
  tf_init >/dev/null
  remaining=$("$terraform" -chdir="$ROOT/infra" state list)
  if [[ -n $remaining ]]; then
    echo "The state in $bucket still tracks these resources. Run scripts/prod/teardown.sh destroy first." >&2
    while IFS= read -r address; do
      echo "  $address" >&2
    done <<<"$remaining"
    exit 1
  fi

  confirm "Delete $bucket and every version of every object in it?"

  # Versioning is on, so current objects and old versions both have to go before delete-bucket. delete-objects takes
  # at most 1000 keys, but the CLI merges every page of list-object-versions into one result. --no-paginate keeps each
  # listing to a single S3 page of at most 1000 versions and delete markers combined, so the loop repeats until a page
  # has no keys. --max-items can't replace it, because it counts only Versions and lets delete markers through
  # uncounted.
  while :; do
    objects=$(aws s3api list-object-versions --bucket "$bucket" --region "$REGION" --no-paginate \
      --output json --query '{Objects: [Versions[], DeleteMarkers[]][].{Key:Key,VersionId:VersionId}}')
    if [[ $objects != *'"Key"'* ]]; then
      break
    fi
    # delete-objects exits 0 even when some keys fail, and lists them under Errors. Stopping on them keeps the next
    # listing from returning the same keys forever.
    errors=$(aws s3api delete-objects --bucket "$bucket" --region "$REGION" --delete "$objects" \
      --query 'Errors' --output json)
    if [[ $errors != null && $errors != '[]' ]]; then
      echo "S3 refused to delete some objects in $bucket:" >&2
      echo "$errors" >&2
      exit 1
    fi
  done

  aws s3api delete-bucket --bucket "$bucket" --region "$REGION"
  echo "Deleted $bucket."
}

cleanup() {
  local secret_live=false has_role=false repo_var present_vars=() policy

  # Checks the signed-in account against AWS_ACCOUNT_ID when that is still set. The bucket check doesn't depend on it,
  # so a variable deleted by hand can't let this step remove the secret and role a live stack still uses.
  has_deploy_account || true
  if has_state_bucket; then
    echo "The state bucket still exists. Run scripts/prod/teardown.sh destroy and state-bucket first." >&2
    exit 1
  fi

  # A secret already scheduled for deletion is left to its schedule.
  if [[ $(aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_NAME" \
    --query DeletedDate --output text 2>/dev/null || true) == None ]]; then
    secret_live=true
  fi
  if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
    has_role=true
  fi
  for repo_var in "${REPO_VARS[@]}"; do
    if [[ -n $(gh variable get "$repo_var" 2>/dev/null || true) ]]; then
      present_vars+=("$repo_var")
    fi
  done

  if [[ $secret_live == false && $has_role == false && ${#present_vars[@]} -eq 0 ]]; then
    echo "cleanup: the Clerk secret, the $ROLE role and the repository variables are already gone."
    return
  fi

  echo
  if [[ $secret_live == true ]]; then
    echo "  Schedule for deletion in 30 days:  $SECRET_NAME"
  fi
  if [[ $has_role == true ]]; then
    echo "  Delete IAM role:                   $ROLE"
  fi
  if [[ ${#present_vars[@]} -gt 0 ]]; then
    echo "  Delete repository variables:       ${present_vars[*]}"
  fi
  confirm "Delete these from account $AWS_ACCOUNT_ID and this repository?"

  # A recovery window rather than an immediate delete. Until it ends, scripts/prod/bootstrap.sh prereqs restores the
  # secret with its value instead of asking for the key again.
  if [[ $secret_live == true ]]; then
    aws secretsmanager delete-secret --region "$REGION" --secret-id "$SECRET_NAME" >/dev/null
    echo "Scheduled $SECRET_NAME for deletion."
  fi

  # delete-role refuses while the role still has inline policies.
  if [[ $has_role == true ]]; then
    for policy in $(aws iam list-role-policies --role-name "$ROLE" --query 'PolicyNames[]' --output text); do
      aws iam delete-role-policy --role-name "$ROLE" --policy-name "$policy"
    done
    aws iam delete-role --role-name "$ROLE"
    echo "Deleted $ROLE."
  fi

  # AWS_ACCOUNT_ID last, since has_deploy_account reads it to tell a finished teardown from one that hasn't started.
  for repo_var in "${present_vars[@]}"; do
    if [[ $repo_var != AWS_ACCOUNT_ID ]]; then
      gh variable delete "$repo_var"
    fi
  done
  if [[ " ${present_vars[*]} " == *" AWS_ACCOUNT_ID "* ]]; then
    gh variable delete AWS_ACCOUNT_ID
  fi
  echo "Deleted the repository variables."
}

aws_require_login
gh_require_login

case $STEP in
  disable) disable_deploys ;;
  destroy) destroy ;;
  state-bucket) delete_state_bucket ;;
  cleanup) cleanup ;;
  "")
    disable_deploys
    destroy
    delete_state_bucket
    cleanup
    ;;
esac
