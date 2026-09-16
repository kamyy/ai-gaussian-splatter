#!/usr/bin/env bash
# Stage 2 of a local pipeline run: trains a splat scripts/dev/worker-reconstruct.sh reconstructed. It fetches the photos
# and sparse model from S3, so it needs nothing left in worker/jobdir and can run on a different machine or days later.
# Success leaves result.ply and thumbnail.png under splats/<splat-id>/ in web/.env's SPLATS_BUCKET.
#
# Usage: scripts/dev/worker-train.sh <splat-id> [--fast]
#
# --fast cuts training to 20 iterations. It doesn't cut GPU memory. Every photo stays resident at full resolution
# whatever the iteration count, so a GPU smaller than a 24GB A10G needs fewer or downscaled photos to even get through a
# smoke test.

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/worker.sh"

usage() {
  echo "Usage: scripts/dev/worker-train.sh <splat-id> [--fast]" >&2
  exit 1
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
fi

SPLAT_ID=$1
extra_args=()
case ${2:-} in
  "") ;;
  --fast) extra_args=(-e FAST_TEST_MODE=true) ;;
  *) usage ;;
esac

# The pipeline's AWS calls happen inside the container. Checking the web/.env key pair on the host first fails in
# seconds rather than after the image build.
use_dev_aws_env
build_worker_image

mkdir -p "$ROOT/worker/jobdir"
run_worker_stage "$SPLAT_ID" train "${extra_args[@]}"
