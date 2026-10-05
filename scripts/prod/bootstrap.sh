#!/usr/bin/env bash
# Takes a fresh AWS account to a live deploy: account prerequisites, the CI role, the GitHub repository variables, the
# deploy switch, the first deploy and the first worker images.
#
# infra/ can't create what its own deploy depends on, so this does it from a workstation signed in as an admin. Each
# step is one subcommand, so a single step can be re-run on its own, such as `ci-role` after the deploy job hits an
# AccessDenied. Every step checks what already exists and skips what is done, so running the whole script again is safe.
# RUNBOOK.md's Going live says what is left to do by hand afterwards.

# shellcheck disable=SC2034 # Each repository variable's value is read back through ${!repo_var} in gh_vars.
set -euo pipefail

usage() {
  echo "Usage: scripts/prod/bootstrap.sh [STEP]"
  echo
  echo "With no STEP, runs every step below in order. Each one skips what is already done, so a re-run is safe."
  echo
  echo "Steps:"
  echo "  prereqs   Creates what infra/ can't: the Clerk secret ai-gaussian-splatter/clerk-secret-key (prompts for its"
  echo "            sk_live_ value), the AWSServiceRoleForEC2Spot role, and the ai-gaussian-splatter-tfstate-<account>"
  echo "            Terraform state bucket. Never overwrites an existing secret's value."
  echo "  ci-role   Creates GitHub's OIDC provider and the ai-gaussian-splatter-ci-deploy role the deploy job"
  echo "            assumes, or rewrites the role's policies from scripts/prod/ci-role-policies/. Run it alone after"
  echo "            adding a missing action to scripts/prod/ci-role-policies/deploy.json when the deploy job fails"
  echo "            with AccessDenied."
  echo "  gh-vars   Sets the GitHub repository variables .github/workflows/deploy.yml reads. Looks up the account,"
  echo "            hosted zone and secret ARN, and asks for the rest with the current values as defaults. Run it"
  echo "            alone to change the domain, alert email, Clerk publishable key, Google Analytics ID or worker AMI."
  echo "  enable    Sets DEPLOY_ENABLED to true, so pushes to main deploy. Refuses while a CI run on main is"
  echo "            unfinished."
  echo "  deploy    Runs .github/workflows/ci.yml on main and waits for its deploy job. In a full run it is skipped"
  echo "            once the web service exists. Run alone, it always deploys."
  echo "  worker    Builds and pushes the worker images from origin/main and deploys them if needed, by running"
  echo "            scripts/prod/worker-push-image.sh."
  echo
  echo "Needs aws login as an admin of the target account, gh login with write access to this repository, and podman."
  echo "scripts/prod/teardown.sh undoes all of this."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

STEP=${1-}
case $STEP in
  "" | prereqs | ci-role | gh-vars | enable | deploy | worker) ;;
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

PROJECT_TAG=ai-gaussian-splatter
REGION=$(tf_get_aws_region)
SECRET_NAME=ai-gaussian-splatter/clerk-secret-key
ROLE=ai-gaussian-splatter-ci-deploy
OIDC_HOST=token.actions.githubusercontent.com
POLICY_DIR=$ROOT/scripts/prod/ci-role-policies

# Reads a secret from the terminal and prints a * per character, so a paste is visible as a mask.
# Backspace removes one character. Ctrl-U clears the line.
read_masked() {
  local prompt=$1 char
  local -n dest=$2
  dest=
  printf '%s' "$prompt"
  # Bracketed paste would otherwise land its escape sequences in the value, one * at a time.
  printf '\e[?2004l'
  while IFS= read -r -s -n1 char; do
    if [[ -z $char ]]; then
      break
    fi
    case $char in
      $'\177' | $'\b')
        if [[ -n $dest ]]; then
          dest=${dest%?}
          printf '\b \b'
        fi
        ;;
      $'\025')
        while [[ -n $dest ]]; do
          dest=${dest%?}
          printf '\b \b'
        done
        ;;
      *)
        dest+=$char
        printf '*'
        ;;
    esac
  done
  echo
}

# Prints the Clerk secret's state: live, missing, or scheduled for deletion. Only ResourceNotFoundException means
# missing. Any other error stops here, rather than prompting for a key that create-secret would then refuse.
get_secret_state() {
  local deleted_date
  if ! deleted_date=$(aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_NAME" \
    --query DeletedDate --output text 2>&1); then
    if [[ $deleted_date != *ResourceNotFoundException* ]]; then
      echo "$deleted_date" >&2
      exit 1
    fi
    echo missing
  elif [[ $deleted_date == None ]]; then
    echo live
  else
    echo scheduled-for-deletion
  fi
}

prereqs() {
  local bucket=ai-gaussian-splatter-tfstate-$AWS_ACCOUNT_ID secret_state has_spot_role=false has_bucket=false
  local clerk_secret_key secret_arn create_bucket_args=()

  secret_state=$(get_secret_state)
  if aws iam get-role --role-name AWSServiceRoleForEC2Spot >/dev/null 2>&1; then
    has_spot_role=true
  fi
  if aws s3api head-bucket --bucket "$bucket" --region "$REGION" 2>/dev/null; then
    has_bucket=true
  fi

  if [[ $secret_state == live && $has_spot_role == true && $has_bucket == true ]]; then
    echo "prereqs: the Clerk secret, AWSServiceRoleForEC2Spot and $bucket already exist."
  else
    confirm "Create whichever of the Clerk secret, AWSServiceRoleForEC2Spot and $bucket is missing in $REGION?"
  fi

  case $secret_state in
    live)
      echo "$SECRET_NAME already exists, so its value was left alone."
      ;;
    scheduled-for-deletion)
      # ECS can't read a secret scheduled for deletion, and create-secret can't reuse the name until the deletion goes
      # through. Restoring it is the only way to keep this name.
      aws secretsmanager restore-secret --region "$REGION" --secret-id "$SECRET_NAME" >/dev/null
      echo "$SECRET_NAME was scheduled for deletion, so it was restored with the value it had before."
      ;;
    missing)
      read_masked "Clerk secret key (sk_live_...): " clerk_secret_key
      if [[ $clerk_secret_key != sk_live_* ]]; then
        echo "That isn't a live Clerk secret key." >&2
        exit 1
      fi
      # Piped on stdin, since an argument would show in the process list. printf is a builtin, so it spawns no process
      # of its own. Unlike a here-string, it adds no trailing newline to the stored value.
      secret_arn=$(printf '%s' "$clerk_secret_key" | aws secretsmanager create-secret --region "$REGION" \
        --name "$SECRET_NAME" --description "clerk-secret-key" --secret-string file:///dev/stdin \
        --query ARN --output text)
      echo "Created $SECRET_NAME: $secret_arn"
      ;;
  esac
  aws secretsmanager tag-resource --region "$REGION" --secret-id "$SECRET_NAME" \
    --tags "Key=Project,Value=$PROJECT_TAG"

  # Creating this role a second time fails outright, hence the guard.
  if [[ $has_spot_role == false ]]; then
    aws iam create-service-linked-role --aws-service-name spot.amazonaws.com >/dev/null
    echo "Created AWSServiceRoleForEC2Spot."
  fi

  # us-east-1 is the one region create-bucket rejects a LocationConstraint for, because it is the API's own default.
  if [[ $REGION != us-east-1 ]]; then
    create_bucket_args=(--create-bucket-configuration "LocationConstraint=$REGION")
  fi
  if [[ $has_bucket == false ]]; then
    aws s3api create-bucket --bucket "$bucket" --region "$REGION" "${create_bucket_args[@]}" >/dev/null
    echo "Created state bucket $bucket."
  fi

  # Reapplied on every run, so a bucket created some other way still ends up versioned, encrypted and private.
  aws s3api put-bucket-versioning --bucket "$bucket" --region "$REGION" \
    --versioning-configuration Status=Enabled
  aws s3api put-bucket-encryption --bucket "$bucket" --region "$REGION" \
    --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  aws s3api put-public-access-block --bucket "$bucket" --region "$REGION" \
    --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  # Replaces the bucket's whole tag set. This bucket only carries Project.
  aws s3api put-bucket-tagging --bucket "$bucket" --region "$REGION" \
    --tagging "{\"TagSet\":[{\"Key\":\"Project\",\"Value\":\"$PROJECT_TAG\"}]}"
}

# Prints one of scripts/prod/ci-role-policies/ with this deploy's values filled in. Only the named variables are
# substituted, so any other $ in a policy reaches IAM untouched.
render_policy() {
  local file=$1
  # shellcheck disable=SC2016 # envsubst takes the variable names literally, so they must not expand here.
  AWS_ACCOUNT_ID=$AWS_ACCOUNT_ID REGION=$REGION OIDC_HOST=$OIDC_HOST SUBJECT=$SUBJECT \
    envsubst '${AWS_ACCOUNT_ID} ${REGION} ${OIDC_HOST} ${SUBJECT}' <"$POLICY_DIR/$file"
}

# Succeeds when two policy documents are the same JSON, ignoring key order and whitespace.
same_policy() {
  local a=$1 b=$2
  [[ $(jq -S . <<<"$a") == $(jq -S . <<<"$b") ]]
}

# The deploy policy in scripts/prod/ci-role-policies/deploy.json grants what a full apply and teardown of infra/ need:
# - Image push is the web repository only. The worker images are pushed from a workstation by
#   scripts/prod/worker-push-image.sh.
# - App S3 ARNs name the uploads, splats, and access-logs buckets. DeleteBucket is on those names only. The state
#   bucket's statement is GetObject, ListBucket, PutObject, and DeleteObject.
# - iam:CreateServiceLinkedRole is for the ECS, ELB, RDS, and Application Auto Scaling roles a first apply creates. The
#   prereqs step only creates AWSServiceRoleForEC2Spot.
# - The Lambda, EventBridge and SNS statements cover the worker sweeper (infra/worker_sweeper.tf) by its fixed names.
#   The sns:Subscribe and sns:Unsubscribe grants end in a wildcard because a subscription's ARN carries a generated
#   suffix. iam:PassRole on the sweeper's role is limited to Lambda, so the CI role can't hand that role to another
#   service.
# - cloudwatch:DescribeAlarms, logs:DescribeLogGroups and ssm:DescribeParameters are list APIs and ignore a resource
#   ARN.
# - The SSM grants cover the runtime settings infra/settings.tf creates. PutParameter only runs when Terraform creates a
#   setting, since infra/settings.tf ignores later changes to each value.
# It is a reasonable starting point, not an exhaustively verified minimum, so a first deploy can still hit AccessDenied.
ci_role() {
  local repo_name sub_prefix providers trust_policy deploy_policy current_trust current_deploy role_exists=false

  # {owner}/{repo} are gh's own placeholders, resolved from this checkout's origin remote.
  repo_name=$(gh api 'repos/{owner}/{repo}' --jq .full_name)
  # The form of the token's sub claim depends on the repository's OIDC subject setting. With immutable subjects on it
  # is repo:OWNER@OWNER_ID/REPO@REPO_ID, and otherwise repo:OWNER/REPO. IAM's StringEquals is exact, so the prefix
  # comes from GitHub rather than being assumed.
  sub_prefix=$(gh api 'repos/{owner}/{repo}/actions/oidc/customization/sub' --jq .sub_claim_prefix)
  if [[ $sub_prefix != repo:* ]]; then
    echo "GitHub reported no usable OIDC sub claim prefix for $repo_name: $sub_prefix" >&2
    exit 1
  fi
  SUBJECT="$sub_prefix:ref:refs/heads/main"

  trust_policy=$(render_policy trust.json)
  deploy_policy=$(render_policy deploy.json)

  providers=$(aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text)
  if current_trust=$(aws iam get-role --role-name "$ROLE" \
    --query Role.AssumeRolePolicyDocument --output json 2>/dev/null); then
    role_exists=true
    current_deploy=$(aws iam get-role-policy --role-name "$ROLE" --policy-name deploy \
      --query PolicyDocument --output json 2>/dev/null || echo '{}')
    if [[ $providers == *"oidc-provider/$OIDC_HOST"* ]] && same_policy "$current_trust" "$trust_policy" &&
      same_policy "$current_deploy" "$deploy_policy"; then
      echo "ci-role: $ROLE already trusts $SUBJECT and carries the current policies."
      return
    fi
  fi

  confirm "Create or update the $ROLE role in account $AWS_ACCOUNT_ID, trusting $SUBJECT?"

  # IAM allows only one OIDC provider per URL per account, and a repeat create fails with EntityAlreadyExists. If
  # another app in this account created it already, reuse it. Only this app's role and its trust policy are new.
  if [[ $providers != *"oidc-provider/$OIDC_HOST"* ]]; then
    # No --thumbprint-list: IAM validates GitHub's TLS cert against its own trusted root CA library first, since
    # GitHub's OIDC endpoint chains to a public CA, and only falls back to thumbprint matching when it doesn't.
    aws iam create-open-id-connect-provider --url "https://$OIDC_HOST" --client-id-list sts.amazonaws.com >/dev/null
  fi

  if [[ $role_exists == true ]]; then
    aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "$trust_policy"
  else
    aws iam create-role --role-name "$ROLE" --assume-role-policy-document "$trust_policy" >/dev/null
  fi
  aws iam tag-role --role-name "$ROLE" --tags "Key=Project,Value=$PROJECT_TAG"
  aws iam put-role-policy --role-name "$ROLE" --policy-name deploy --policy-document "$deploy_policy"
  echo "Role ready: arn:aws:iam::$AWS_ACCOUNT_ID:role/$ROLE"
}

# Prints a repository variable's current value, or nothing when it's unset.
current_repo_var() {
  local repo_var=$1
  gh variable get "$repo_var" 2>/dev/null || true
}

# Usage: ask <prompt> <default>
#
# Prints the answer. An empty answer takes the default, and an empty result exits.
ask() {
  local prompt=$1 default=$2 answer
  read -rp "$prompt${default:+ [$default]}: " answer
  answer=${answer:-$default}
  if [[ -z $answer ]]; then
    echo "A value is required." >&2
    exit 1
  fi
  printf '%s\n' "$answer"
}

gh_vars() {
  local amis current_ami current_ga repo_var repo_vars changed=()

  DOMAIN_ZONE_NAME=$(ask "Public DNS zone the app is served from" "$(current_repo_var DOMAIN_ZONE_NAME)")
  # A zone name copied from the Route 53 console arrives as "example.com.", and the lookup below matches the API's own
  # lowercase spelling exactly. var.domain_zone_name's validation rejects both forms, so they are normalized here
  # rather than left to fail at the first apply.
  DOMAIN_ZONE_NAME=${DOMAIN_ZONE_NAME%.}
  DOMAIN_ZONE_NAME=${DOMAIN_ZONE_NAME,,}
  # The API returns the ID as /hostedzone/<id>, and var.hosted_zone_id takes the bare ID.
  HOSTED_ZONE_ID=$(aws route53 list-hosted-zones-by-name --dns-name "$DOMAIN_ZONE_NAME" \
    --query "HostedZones[?Name=='$DOMAIN_ZONE_NAME.' && Config.PrivateZone==\`false\`].Id | [0]" \
    --output text | cut -d/ -f3)
  if [[ $HOSTED_ZONE_ID != Z* ]]; then
    echo "No public hosted zone named $DOMAIN_ZONE_NAME in account $AWS_ACCOUNT_ID." >&2
    exit 1
  fi

  if ! CLERK_SECRET_KEY_ARN=$(aws secretsmanager describe-secret --region "$REGION" \
    --secret-id "$SECRET_NAME" --query ARN --output text); then
    echo "Create the Clerk secret first: scripts/prod/bootstrap.sh prereqs" >&2
    exit 1
  fi

  ALERT_EMAIL=$(ask "Budget alert email" "$(current_repo_var ALERT_EMAIL)")

  CLERK_PUBLISHABLE_KEY=$(ask "Clerk publishable key (pk_live_...)" "$(current_repo_var CLERK_PUBLISHABLE_KEY)")
  if [[ $CLERK_PUBLISHABLE_KEY != pk_live_* ]]; then
    echo "That isn't the production instance's pk_live_* key. A pk_test_* key doesn't match the live secret key." >&2
    exit 1
  fi

  # Optional, so it skips ask(), which refuses an empty answer. An empty answer keeps the current value. Clear it with
  # gh variable delete GA_MEASUREMENT_ID.
  current_ga=$(current_repo_var GA_MEASUREMENT_ID)
  read -rp "Google Analytics 4 measurement ID (G-..., empty for none)${current_ga:+ [$current_ga]}: " GA_MEASUREMENT_ID
  GA_MEASUREMENT_ID=${GA_MEASUREMENT_ID:-$current_ga}
  if [[ -n $GA_MEASUREMENT_ID && $GA_MEASUREMENT_ID != G-* ]]; then
    echo "That isn't a GA4 measurement ID. It starts with G-." >&2
    exit 1
  fi

  echo "Newest Deep Learning Base GPU AMIs:"
  amis=$(aws ec2 describe-images --region "$REGION" --owners amazon \
    --filters "Name=name,Values=Deep Learning Base*GPU AMI*Ubuntu*" \
    "Name=architecture,Values=x86_64" \
    "Name=state,Values=available" \
    --query 'reverse(sort_by(Images,&CreationDate))[:5].[ImageId,CreationDate,Name]' \
    --output text)
  printf '%s\n' "$amis"
  current_ami=$(current_repo_var WORKER_AMI_ID)
  WORKER_AMI_ID=$(ask "Worker AMI" "${current_ami:-${amis%%$'\t'*}}")

  # Seeded with the tag the worker step will push, so the first deploy already names the images that step builds and
  # needs no second deploy. scripts/prod/worker-push-image.sh owns the value from then on.
  WORKER_IMAGE_TAG=$(current_repo_var WORKER_IMAGE_TAG)
  if [[ -z $WORKER_IMAGE_TAG ]]; then
    git -C "$ROOT" fetch --quiet origin main
    WORKER_IMAGE_TAG=$(tf_get_worker_image_tag origin/main)
  fi

  # DEPLOY_ENABLED is deliberately absent. The enable step owns it.
  repo_vars=(AWS_ACCOUNT_ID DOMAIN_ZONE_NAME HOSTED_ZONE_ID CLERK_SECRET_KEY_ARN ALERT_EMAIL WORKER_AMI_ID
    WORKER_IMAGE_TAG CLERK_PUBLISHABLE_KEY)
  # GitHub refuses an empty variable, so GA_MEASUREMENT_ID joins the list only when it has a value.
  if [[ -n $GA_MEASUREMENT_ID ]]; then
    repo_vars+=(GA_MEASUREMENT_ID)
  fi
  for repo_var in "${repo_vars[@]}"; do
    if [[ $(current_repo_var "$repo_var") != "${!repo_var}" ]]; then
      changed+=("$repo_var")
    fi
  done

  echo "The app will serve from https://$(tf_get_app_hostname "$DOMAIN_ZONE_NAME")."
  if [[ ${#changed[@]} -eq 0 ]]; then
    echo "gh-vars: every repository variable already has these values."
  else
    echo
    for repo_var in "${changed[@]}"; do
      printf '  %-22s %s\n' "$repo_var" "${!repo_var}"
    done
    confirm "Set these repository variables on $(gh repo view --json nameWithOwner --jq .nameWithOwner)?"
    for repo_var in "${changed[@]}"; do
      gh variable set "$repo_var" --body "${!repo_var}"
    done
  fi

  # .github/workflows/deploy.yml builds the app's origin as https://ai-gaussian-splatter.<DOMAIN_ZONE_NAME>, so an
  # APP_PUBLIC_URL repository variable feeds nothing. Removed rather than left in the list reading as live
  # configuration.
  if [[ -n $(current_repo_var APP_PUBLIC_URL) ]]; then
    gh variable delete APP_PUBLIC_URL
    echo "Deleted APP_PUBLIC_URL, which nothing reads."
  fi
}

enable_deploys() {
  local main_sha
  if [[ $(gh_get_deploy_enabled) == true ]]; then
    echo "enable: DEPLOY_ENABLED is already true."
    return
  fi

  # Read from the API rather than origin/main, which is only as fresh as the last fetch.
  main_sha=$(gh api "repos/{owner}/{repo}/commits/main" --jq '.sha[:7]')
  echo "Once on, every push to main that is not only .md files or LICENSE deploys. Current main on GitHub: $main_sha"
  confirm "Turn the deploy job on?"

  # Checked here rather than earlier, so the gap between the check and the write stays one API round-trip. A run whose
  # capture-deploy-enabled job has not reached a runner yet still reads this variable live.
  gh_require_no_in_progress_ci
  gh variable set DEPLOY_ENABLED --body true
  echo "DEPLOY_ENABLED is now true."
}

# Succeeds when the web service exists, which is what a first deploy creates.
has_web_service() {
  local status
  status=$(aws ecs describe-services --region "$REGION" --cluster ai-gaussian-splatter \
    --services ai-gaussian-splatter-web --query 'services[0].status' --output text 2>/dev/null || true)
  [[ $status == ACTIVE ]]
}

run_deploy() {
  local always=$1
  gh_require_aws_deploy_account
  if [[ $(gh_get_deploy_enabled) != true ]]; then
    echo "DEPLOY_ENABLED isn't true, so a run would skip its deploy job. Run: scripts/prod/bootstrap.sh enable" >&2
    exit 1
  fi
  if [[ $always == false ]] && has_web_service; then
    echo "deploy: the web service already exists. Run scripts/prod/bootstrap.sh deploy to deploy again anyway."
    return
  fi

  confirm "Run ci.yml on main and wait for its deploy job? A first deploy takes around 20 minutes."
  gh_run_deploy
}

release_worker() {
  "$ROOT/scripts/prod/worker-push-image.sh"
}

# What the dashboards and inboxes still need once the stack is up. None of it has an API this script could call.
print_manual_steps() {
  echo
  echo "Still to do by hand (RUNBOOK.md, Going live):"
  echo "  1. Click the subscription link AWS emailed to ALERT_EMAIL, or the sweeper's alerts never arrive."
  echo "  2. In the production Clerk dashboard's Legal page, require express consent and set the /terms and /privacy"
  echo "     URLs."
  echo "  3. In the production Clerk dashboard's User & authentication page, turn off Allow users to delete their"
  echo "     accounts."
  echo "  4. Run scripts/prod/ssm.sh and check every runtime setting is listed."
}

aws_require_login
gh_require_login

case $STEP in
  prereqs) prereqs ;;
  ci-role) ci_role ;;
  gh-vars) gh_vars ;;
  enable) enable_deploys ;;
  deploy) run_deploy true ;;
  worker) release_worker ;;
  "")
    prereqs
    ci_role
    gh_vars
    enable_deploys
    run_deploy false
    release_worker
    print_manual_steps
    ;;
esac
