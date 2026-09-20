#!/usr/bin/env bash
# The train stage fetches the photos and sparse model from S3, so it needs nothing left in worker/jobdir and can run on
# a different machine or days later. Success leaves result.ply and thumbnail.png under splats/<splat-id>/ in web/.env's
# SPLATS_BUCKET.
#
# --fast does not cut GPU memory, because every photo stays resident in VRAM for the whole run, downscaled to
# worker/pipeline/train.py's MAX_TRAINING_EDGE longest edge. What a smoke test costs in memory therefore follows the
# photo count rather than the iteration count.

set -euo pipefail

usage() {
  echo "Usage: scripts/dev/worker-train.sh <splat-id> [--fast]"
  echo
  echo "Stage 2 of a local pipeline run: trains a splat that scripts/dev/worker-reconstruct.sh reconstructed."
  echo "--fast cuts training to 20 iterations. It doesn't cut GPU memory."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage >&2
  exit 1
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/worker.sh"

SPLAT_ID=$1
flag=${2:-}
extra_args=()
case $flag in
  "") ;;
  --fast) extra_args=(-e FAST_TEST_MODE=true) ;;
  *)
    usage >&2
    exit 1
    ;;
esac

# The pipeline's AWS calls happen inside the container. Checking the web/.env key pair on the host first fails in
# seconds rather than after the image build.
worker_use_dev_aws
worker_build_image train

mkdir -p "$ROOT/worker/jobdir"
worker_run_stage "$SPLAT_ID" train "${extra_args[@]}"
