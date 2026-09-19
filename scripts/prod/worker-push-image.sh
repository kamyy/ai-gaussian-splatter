#!/usr/bin/env bash
# Builds the worker image from this commit, pushes it to the ai-gaussian-splatter-worker ECR repository, and points the
# WORKER_IMAGE_TAG repository variable at it.

set -euo pipefail

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

# Either tag already being present means this commit was pushed before. Checked before the build, because a pushed
# tag can never be replaced and the repository holds both.
for stage in "${STAGES[@]}"; do
  if IMAGE_CHECK=$(aws ecr describe-images --region "$REGION" --repository-name "$REPO" \
    --image-ids imageTag="$TAG-$stage" 2>&1); then
    echo "$REPO:$TAG-$stage is already pushed, and a pushed tag can never be replaced. Commit again for a new build." >&2
    exit 1
  fi
  if [[ $IMAGE_CHECK != *ImageNotFoundException* ]]; then
    echo "$IMAGE_CHECK" >&2
    exit 1
  fi
done

confirm "Build and push $REPO:$TAG-reconstruct and $REPO:$TAG-train to account $AWS_ACCOUNT_ID, then set WORKER_IMAGE_TAG=$TAG?"

aws ecr get-login-password --region "$REGION" | podman login --username AWS --password-stdin "$REGISTRY"

# Both images are built before either is pushed, so a build failure in the second leaves nothing half-released under
# a tag that can never be reused. WORKER_IMAGE_TAG is set only once both are up, because a deploy reading it expects
# to find both.
for stage in "${STAGES[@]}"; do
  podman build --target "$stage" -t "$REGISTRY/$REPO:$TAG-$stage" "$ROOT/worker"
done
for stage in "${STAGES[@]}"; do
  podman push "$REGISTRY/$REPO:$TAG-$stage"
done
gh variable set WORKER_IMAGE_TAG --body "$TAG"

echo "WORKER_IMAGE_TAG is now $TAG. The next deploy points both worker image URIs at it."
