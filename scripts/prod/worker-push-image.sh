#!/usr/bin/env bash
# Releases worker/ as GitHub's main branch holds it: builds the worker images, pushes them, and deploys them.
#
# No deploy builds the worker, so this is how a worker/ change reaches AWS once it has merged. The images are built from
# an extract of origin/main, never from this checkout, so the branch checked out here and any uncommitted or untracked
# file in worker/ can't reach production. They go to the worker ECR repository (AWS's container registry) tagged with
# worker/'s git tree id. The script then points the WORKER_IMAGE_TAG repository variable at that tag and runs
# .github/workflows/ci.yml on main, whose deploy job hands the new image URIs to the web app.

set -euo pipefail

usage() {
  echo "Usage: scripts/prod/worker-push-image.sh"
  echo
  echo "Releases worker/ as it is on GitHub's main branch. This checkout's branch and its uncommitted, untracked or"
  echo "unpushed changes are ignored."
  echo
  echo "Steps, each skipped when it's already done:"
  echo "  1. Fetch main and extract its worker/ into a temporary directory."
  echo "  2. Build the reconstruct and train images there and push them to the ai-gaussian-splatter-worker ECR"
  echo "     repository, tagged <worker/ tree id>-reconstruct and <worker/ tree id>-train."
  echo "  3. Set the WORKER_IMAGE_TAG repository variable to that tree id."
  echo "  4. Run .github/workflows/ci.yml on main and wait for it. Its deploy job points the web app's worker launches"
  echo "     at the new images. Skipped while the DEPLOY_ENABLED repository variable isn't true."
  echo
  echo "Safe to re-run. An image already in ECR isn't rebuilt, and a tag the web app already runs with starts no"
  echo "deploy."
  echo "Needs aws login as an admin of the deployed account, gh login, and podman."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi
if [[ $# -ne 0 ]]; then
  usage >&2
  exit 1
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/aws.sh"
source "$ROOT/scripts/lib/confirm.sh"
source "$ROOT/scripts/lib/github.sh"
source "$ROOT/scripts/lib/terraform.sh"

REPO=ai-gaussian-splatter-worker
REGION=$(tf_get_aws_region)
# One release is two images, one per worker-job stage. infra/locals.tf appends these same suffixes when it builds the
# URIs the web task hands to web/lib/server/ec2Launcher.ts.
STAGES=(reconstruct train)

# Prints the worker tag the running web service launches with, read off its task definition's WORKER_TRAIN_IMAGE_URI.
# Prints nothing when no service exists yet. This, not WORKER_IMAGE_TAG, says whether a deploy is still needed, since a
# run that set the variable and then failed its deploy leaves the two different.
get_live_worker_image_tag() {
  local task_def image

  # shellcheck disable=SC2016 # The backticks are a JMESPath literal, not command substitution.
  if ! task_def=$(aws ecs describe-services --region "$REGION" \
    --cluster ai-gaussian-splatter --services ai-gaussian-splatter-web \
    --query 'services[0].deployments[?status==`PRIMARY`].taskDefinition | [0]' --output text 2>&1); then
    if [[ $task_def != *ClusterNotFoundException* ]]; then
      echo "$task_def" >&2
      exit 1
    fi
    return
  fi
  if [[ -z $task_def || $task_def == None ]]; then
    return
  fi

  # shellcheck disable=SC2016 # The backticks are a JMESPath literal, not command substitution.
  image=$(aws ecs describe-task-definition --region "$REGION" --task-definition "$task_def" \
    --query 'taskDefinition.containerDefinitions[0].environment[?name==`WORKER_TRAIN_IMAGE_URI`].value | [0]' \
    --output text)
  image=${image##*:}
  printf '%s\n' "${image%-train}"
}

aws_require_login
gh_require_login

# Every deploy reads WORKER_IMAGE_TAG, so a push to any other account would point production at an image it doesn't
# have.
gh_require_aws_deploy_account
REGISTRY=$AWS_ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com

git -C "$ROOT" fetch --quiet origin main
TAG=$(tf_get_worker_image_tag origin/main)
echo "Releasing worker/ from origin/main ($(git -C "$ROOT" rev-parse --short origin/main)) as tag $TAG."

# Both checks run before a build that would otherwise only fail at the push. Each reads only its own not-found
# error as an answer. Any other error stops here with AWS's own message.
if ! REPO_CHECK=$(aws ecr describe-repositories --region "$REGION" --repository-names "$REPO" 2>&1); then
  if [[ $REPO_CHECK == *RepositoryNotFoundException* ]]; then
    echo "ECR repository $REPO doesn't exist in account $AWS_ACCOUNT_ID. The first deploy creates it." >&2
  else
    echo "$REPO_CHECK" >&2
  fi
  exit 1
fi

# A pushed tag can never be replaced, so only the missing stages are built. A run that pushed one image and failed on
# the other is finished by re-running.
PENDING=()
for stage in "${STAGES[@]}"; do
  if IMAGE_CHECK=$(aws ecr describe-images --region "$REGION" --repository-name "$REPO" \
    --image-ids imageTag="$TAG-$stage" 2>&1); then
    continue
  fi
  if [[ $IMAGE_CHECK != *ImageNotFoundException* ]]; then
    echo "$IMAGE_CHECK" >&2
    exit 1
  fi
  PENDING+=("$stage")
done

CURRENT_VAR=$(gh variable get WORKER_IMAGE_TAG 2>/dev/null || true)
LIVE_TAG=$(get_live_worker_image_tag)
DEPLOY_ENABLED=$(gh_get_deploy_enabled)

# No live tag means no web service yet. Its first deploy starts on WORKER_IMAGE_TAG, so nothing needs deploying.
if [[ ${#PENDING[@]} -eq 0 && $CURRENT_VAR == "$TAG" && (-z $LIVE_TAG || $LIVE_TAG == "$TAG") ]]; then
  echo "Tag $TAG is already built, pushed and set. Nothing to do."
  exit 0
fi

# A first deploy already starts the service on the tag set before it, so only an older running tag needs a deploy.
NEEDS_DEPLOY=false
if [[ -n $LIVE_TAG && $LIVE_TAG != "$TAG" ]]; then
  NEEDS_DEPLOY=true
fi

echo
if [[ ${#PENDING[@]} -gt 0 ]]; then
  echo "  Build and push:   ${PENDING[*]} as $REPO:$TAG-<stage>"
fi
if [[ $CURRENT_VAR != "$TAG" ]]; then
  echo "  Set:              WORKER_IMAGE_TAG from ${CURRENT_VAR:-unset} to $TAG"
fi
if [[ $NEEDS_DEPLOY == true && $DEPLOY_ENABLED == true ]]; then
  echo "  Deploy:           run ci.yml on main, moving the web app from worker tag $LIVE_TAG to $TAG"
elif [[ $NEEDS_DEPLOY == true ]]; then
  echo "  Deploy:           skipped, because DEPLOY_ENABLED isn't true. The next deploy picks up the tag."
fi
confirm "Do this in account $AWS_ACCOUNT_ID?"

if [[ ${#PENDING[@]} -gt 0 ]]; then
  CONTEXT=$(mktemp -d)
  trap 'rm -rf "$CONTEXT"' EXIT
  # The archive carries worker/.dockerignore, so the build context is the same allowlist a checkout would give.
  git -C "$ROOT" archive origin/main worker | tar -x -C "$CONTEXT"

  aws ecr get-login-password --region "$REGION" | podman login --username AWS --password-stdin "$REGISTRY"

  # Every image is built before any is pushed, so a build failure in the second leaves nothing half-released under a
  # tag that can never be reused.
  for stage in "${PENDING[@]}"; do
    podman build --target "$stage" -t "$REGISTRY/$REPO:$TAG-$stage" "$CONTEXT/worker"
  done
  for stage in "${PENDING[@]}"; do
    podman push "$REGISTRY/$REPO:$TAG-$stage"
  done
fi

# Set only once both images are up, because a deploy reading it expects to find both suffixes.
if [[ $CURRENT_VAR != "$TAG" ]]; then
  gh variable set WORKER_IMAGE_TAG --body "$TAG"
  echo "WORKER_IMAGE_TAG is now $TAG."
fi

if [[ $NEEDS_DEPLOY == true && $DEPLOY_ENABLED == true ]]; then
  gh_run_deploy
fi
