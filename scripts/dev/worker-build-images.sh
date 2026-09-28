#!/usr/bin/env bash
# The web app's Start button under WORKER_LOCAL_LAUNCH runs whatever splat-worker-<stage>:dev image already exists and
# never builds one, so a worker code change reaches it only after this script.

set -euo pipefail

usage() {
  echo "Usage: scripts/dev/worker-build-images.sh"
  echo
  echo "Builds the splat-worker-reconstruct:dev and splat-worker-train:dev images from worker/ without running either."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

if [[ $# -gt 0 ]]; then
  usage >&2
  exit 1
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/worker.sh"

for stage in reconstruct train; do
  worker_build_image "$stage"
done
