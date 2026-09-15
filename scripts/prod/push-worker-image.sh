#!/usr/bin/env bash
# Builds the worker image from this commit, pushes it to the ai-gaussian-splatter-worker ECR repository, and points the
# WORKER_IMAGE_TAG repository variable at it.

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/require-aws-login.sh"
source "$ROOT/scripts/lib/confirm.sh"
source "$ROOT/scripts/lib/github.sh"

REPO=ai-gaussian-splatter-worker

# The tag is the commit SHA and the repository is IMMUTABLE, so an image of uncommitted changes would stay stuck under a
# SHA that doesn't describe it.
if [[ -n $(git -C "$ROOT" status --porcelain -- worker) ]]; then
  echo "worker/ has uncommitted changes. Commit them first so the image tag names what's in it." >&2
  exit 1
fi
TAG=$(git rev-parse --short HEAD)

require_aws_login
require_gh_login

# Every deploy reads WORKER_IMAGE_TAG, so a push to any other account would point production at an image it doesn't
# have.
require_aws_deploy_account
REGISTRY=$AWS_ACCOUNT_ID.dkr.ecr.us-west-2.amazonaws.com

# Both checks run before a ~19 GB build that would otherwise only fail at the push. Each reads only its own not-found
# error as an answer. Any other error stops here with AWS's own message.
if ! REPO_CHECK=$(aws ecr describe-repositories --region us-west-2 --repository-names "$REPO" 2>&1); then
  if [[ $REPO_CHECK == *RepositoryNotFoundException* ]]; then
    echo "ECR repository $REPO doesn't exist in account $AWS_ACCOUNT_ID. The first deploy creates it." >&2
  else
    echo "$REPO_CHECK" >&2
  fi
  exit 1
fi
if IMAGE_CHECK=$(aws ecr describe-images --region us-west-2 --repository-name "$REPO" --image-ids imageTag="$TAG" \
  2>&1); then
  echo "$REPO:$TAG is already pushed, and a pushed tag can never be replaced. Commit again for a new build." >&2
  exit 1
fi
if [[ $IMAGE_CHECK != *ImageNotFoundException* ]]; then
  echo "$IMAGE_CHECK" >&2
  exit 1
fi

confirm "Build and push $REPO:$TAG to account $AWS_ACCOUNT_ID, then set WORKER_IMAGE_TAG=$TAG?"

aws ecr get-login-password --region us-west-2 | podman login --username AWS --password-stdin "$REGISTRY"
podman build -t "$REGISTRY/$REPO:$TAG" "$ROOT/worker"
podman push "$REGISTRY/$REPO:$TAG"
gh variable set WORKER_IMAGE_TAG --body "$TAG"

echo "WORKER_IMAGE_TAG is now $TAG. The next deploy points WORKER_IMAGE_URI at it."
