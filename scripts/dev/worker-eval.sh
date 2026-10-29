#!/usr/bin/env bash
# Scores the worker's training code on local captures that have already been reconstructed.
#
# Builds the train image from worker/ and runs worker/eval_train.py in it on your GPU. That script trains on each capture
# several times with every 8th photo held back, then prints PSNR and SSIM on those photos.

set -euo pipefail

usage() {
  echo "Usage: scripts/dev/worker-eval.sh [--runs N] [--iterations N] <jobId>..."
  echo
  echo "  <jobId>        A directory name under worker/jobdir/ that holds colmap_sparse/ and photos/. A local"
  echo "                 worker job leaves those after its reconstruct stage."
  echo "  --runs N       Seeds 0 to N-1 per capture (default 3). Compare the same seeds before and after a change."
  echo "  --iterations N Training iterations per run (default: the worker's)."
  echo
  echo "Nothing is uploaded and the capture directories are mounted read-only."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
IMAGE=splat-worker-train:dev

eval_args=()
mounts=()
containerdirs=()
while [[ $# -gt 0 ]]; do
  arg=$1
  case $arg in
    --runs | --iterations)
      if [[ $# -lt 2 ]]; then
        usage >&2
        exit 1
      fi
      if [[ ! $2 =~ ^[0-9]+$ || $2 -lt 1 ]]; then
        echo "$arg takes a whole number of at least 1, not '$2'." >&2
        exit 1
      fi
      eval_args+=("$arg" "$2")
      shift 2
      ;;
    -*)
      usage >&2
      exit 1
      ;;
    *)
      jobdir="$ROOT/worker/jobdir/$arg"
      if [[ ! -d $jobdir/colmap_sparse || ! -d $jobdir/photos ]]; then
        echo "worker/jobdir/$arg has no colmap_sparse/ and photos/. Run its reconstruct stage first." >&2
        exit 1
      fi
      mounts+=(-v "$jobdir:/data/$arg:ro")
      containerdirs+=("/data/$arg")
      shift
      ;;
  esac
done

if [[ ${#containerdirs[@]} -eq 0 ]]; then
  usage >&2
  exit 1
fi

podman build --target train -t "$IMAGE" "$ROOT/worker"

# eval_train.py stays out of the image, because the image also runs on AWS.
podman run --rm --security-opt=label=disable --device nvidia.com/gpu=all \
  -v "$ROOT/worker/eval_train.py:/app/eval_train.py:ro" \
  "${mounts[@]}" \
  "$IMAGE" python3 eval_train.py "${eval_args[@]}" "${containerdirs[@]}"
