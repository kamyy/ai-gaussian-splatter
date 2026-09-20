#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: scripts/prod/worker-push-image.sh"
  echo
  echo "Builds the worker image from this commit, pushes it to the ai-gaussian-splatter-worker ECR repository, and"
  echo "points the WORKER_IMAGE_TAG repository variable at it."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/aws.sh"
source "$ROOT/scripts/lib/confirm.sh"
source "$ROOT/scripts/lib/github.sh"
source "$ROOT/scripts/lib/terraform.sh"

REPO=ai-gaussian-splatter-worker
REGION=$(tf_get_aws_region)

# The tag is the commit SHA and the repository is IMMUTABLE, so an image of uncommitted changes would stay stuck under a
# SHA that doesn't describe it.
if [[ -n $(git -C "$ROOT" status --porcelain -- worker) ]]; then
  echo "worker/ has uncommitted changes. Commit them first so the image tag names what's in it." >&2
  exit 1
fi
TAG=$(git rev-parse --short HEAD)

aws_require_login
gh_require_login

# Every deploy reads WORKER_IMAGE_TAG, so a push to any other account would point production at an image it doesn't
# have.
gh_require_aws_deploy_account
REGISTRY=$AWS_ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com

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
# One commit produces two images, one per worker-job stage, and infra/locals.tf appends these same suffixes when it
# builds the URIs the web task hands to web/lib/server/ec2Launcher.ts.
STAGES=(reconstruct train)

# Which suffixes this commit still needs, checked before the build because a pushed tag can never be replaced. A run
# that pushed one image and failed on the other leaves the repository half-populated, so re-running finishes what is
# missing rather than refusing outright, which would otherwise take an empty commit to get past.
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

if [[ ${#PENDING[@]} -eq 0 ]]; then
  echo "$REPO:$TAG is already pushed for every stage, and a pushed tag can never be replaced." >&2
  echo "Commit again for a new build." >&2
  exit 1
fi
if [[ ${#PENDING[@]} -lt ${#STAGES[@]} ]]; then
  echo "Resuming a partial push of $TAG: ${PENDING[*]} still missing." >&2
fi

confirm "Build and push ${PENDING[*]} for $REPO:$TAG to account $AWS_ACCOUNT_ID, then set WORKER_IMAGE_TAG=$TAG?"

aws ecr get-login-password --region "$REGION" | podman login --username AWS --password-stdin "$REGISTRY"

# Every image is built before any is pushed, so a build failure in the second leaves nothing half-released under a tag
# that can never be reused. WORKER_IMAGE_TAG is set only once all of them are up, because a deploy reading it expects
# to find both suffixes.
for stage in "${PENDING[@]}"; do
  podman build --target "$stage" -t "$REGISTRY/$REPO:$TAG-$stage" "$ROOT/worker"
done
for stage in "${PENDING[@]}"; do
  podman push "$REGISTRY/$REPO:$TAG-$stage"
done
gh variable set WORKER_IMAGE_TAG --body "$TAG"

echo "WORKER_IMAGE_TAG is now $TAG. The next deploy points both worker image URIs at it."
