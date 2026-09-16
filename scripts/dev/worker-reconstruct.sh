#!/usr/bin/env bash
# Stage 1 of a local pipeline run: uploads a photo set under a new SPLAT_ID, then runs COLMAP on it. Stage 2 is
# scripts/dev/worker-train.sh. Needs web/.env's dev AWS keys and the one-time scripts/dev/setup-gpu-passthrough.sh.
#
# Usage: scripts/dev/worker-reconstruct.sh [photos-dir]
#
# photos-dir defaults to worker/photos.

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
PHOTOS=$(realpath -e "${1:-$ROOT/worker/photos}")
source "$ROOT/scripts/lib/worker.sh"
source "$ROOT/scripts/lib/confirm.sh"

# worker/jobdir also holds web/lib/server/ec2Launcher.ts's launchJobLocal() job folders. Asked here rather than beside
# the rm below, so the prompt doesn't wait behind the image build.
if [[ -e "$ROOT/worker/jobdir" ]]; then
  confirm "Delete worker/jobdir, including any Process-button job folders in it?"
fi

use_dev_aws_env
build_worker_image

# Needs to be different for every run.
SPLAT_ID=$(uuidgen)
aws s3 sync "$PHOTOS" "s3://$UPLOADS_BUCKET/splats/$SPLAT_ID/photos/"

rm -rf "$ROOT/worker/jobdir"
mkdir "$ROOT/worker/jobdir"

# Leaves the COLMAP workspace in worker/jobdir/colmap and uploads the sparse model and point_cloud.ply under
# splats/$SPLAT_ID/ in web/.env's SPLATS_BUCKET.
run_worker_stage "$SPLAT_ID" reconstruct

echo "Reconstructed splat $SPLAT_ID. Train it with: scripts/dev/worker-train.sh $SPLAT_ID"
