# shellcheck shell=bash
# Sourced by scripts/dev/worker-reconstruct.sh and scripts/dev/worker-train.sh. Not meant to be run directly.

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/env.sh"

# Exports web/.env's dev key pair, region, and bucket names. The host's AWS CLI then runs as the same
# ai-gaussian-splatter-dev IAM user the container does, and worker_run_stage passes the same values in. Stops the script
# if AWS rejects the keys.
worker_use_dev_aws() {
  if [[ ! -f "$ROOT/web/.env" ]]; then
    echo "web/.env is missing. Run scripts/dev/create-resources.sh to create it." >&2
    exit 1
  fi

  # A session token left in the environment would be sent alongside the dev user's long-term keys, and AWS rejects that
  # pair.
  unset AWS_SESSION_TOKEN
  AWS_ACCESS_KEY_ID=$(env_get "$ROOT/web/.env" AWS_ACCESS_KEY_ID)
  AWS_SECRET_ACCESS_KEY=$(env_get "$ROOT/web/.env" AWS_SECRET_ACCESS_KEY)
  AWS_REGION=$(env_get "$ROOT/web/.env" AWS_REGION)
  UPLOADS_BUCKET=$(env_get "$ROOT/web/.env" UPLOADS_BUCKET)
  SPLATS_BUCKET=$(env_get "$ROOT/web/.env" SPLATS_BUCKET)
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION UPLOADS_BUCKET SPLATS_BUCKET

  # GetCallerIdentity needs no IAM permission, so the dev user's narrow policy can't be what fails it.
  if ! aws sts get-caller-identity >/dev/null 2>&1; then
    echo "AWS rejected the key pair in web/.env." >&2
    echo "Delete the dev user's key (aws iam delete-access-key) if it has one." >&2
    echo "Then run scripts/dev/create-resources.sh to create and write a new one." >&2
    exit 1
  fi
}

# worker/pipeline/ and worker/run_job.py are copied after uv sync, so a code-only edit rebuilds in seconds and an
# unchanged tree is fully cached. Touching pyproject.toml or uv.lock re-runs uv sync as well. Only a cold build
# downloads torch/CUDA (~19 GB).
worker_build_image() {
  podman build -t splat-worker:dev "$ROOT/worker"
}

# Usage: worker_run_stage <splat-id> <stage> [extra podman run args]
#
# Call worker_use_dev_aws first. A full run is two container runs, one per STAGE, because in production each stage
# is its own spot instance and the pause between them is where the user decides whether to pay for training. Each
# variable is passed on its own, the way web/lib/server/ec2Launcher.ts's launchJobLocal() does, so the rest of web/.env
# never reaches the container. Output lands in worker/jobdir and persists after the container exits.
# --security-opt=label=disable is required on every GPU run, or SELinux blocks the device nodes.
worker_run_stage() {
  local splat_id=$1 stage=$2
  shift 2
  # A bare -e NAME copies the value from this shell, which keeps the secret key out of the process list. boto3 reads
  # only AWS_DEFAULT_REGION. Inside the container localhost is the container itself, so status callbacks go to Podman's
  # alias for the host running `next dev`. JOB_ID and CALLBACK_TOKEN only matter to a job the web app launched.
  podman run --rm \
    --security-opt=label=disable \
    --device nvidia.com/gpu=all \
    -e AWS_ACCESS_KEY_ID \
    -e AWS_SECRET_ACCESS_KEY \
    -e AWS_DEFAULT_REGION="$AWS_REGION" \
    -e UPLOADS_BUCKET \
    -e SPLATS_BUCKET \
    -e APP_PUBLIC_URL=http://host.containers.internal:3000 \
    -e JOB_ID=local-test \
    -e CALLBACK_TOKEN=none \
    -e SPLAT_ID="$splat_id" \
    -e STAGE="$stage" \
    "$@" \
    -v "$ROOT/worker/jobdir:/tmp/job" \
    splat-worker:dev
}
