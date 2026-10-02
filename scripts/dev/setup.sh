#!/usr/bin/env bash
# Sets up a machine for local development: dependencies, the pinned Terraform CLI, the dev AWS resources, and GPU
# access for the worker container.
#
# After it, `pnpm dev` from the repo root is the whole daily loop. Each step is one subcommand, so a single step can be
# re-run on its own, such as `aws` after deleting a lost access key. Every step checks what is already in place and
# skips it, so running the whole script again is safe.

set -euo pipefail

usage() {
  echo "Usage: scripts/dev/setup.sh [STEP]"
  echo
  echo "With no STEP, runs every step below in order. Each one skips what is already done, so a re-run is safe."
  echo
  echo "Steps:"
  echo "  deps       pnpm install for the repo root and web/, uv sync for worker/, and enables Podman's restart"
  echo "             service so the splat-pg database container comes back after a reboot."
  echo "  terraform  Installs the exact Terraform version infra/providers.tf pins into ~/.local/bin, after checking"
  echo "             HashiCorp's signature. Skipped when that version is already there."
  echo "  aws        Creates web/.env from web/.env.example if it's missing, then the dev uploads and splats buckets it"
  echo "             names and the ai-gaussian-splatter-dev IAM user that can reach only those two, and writes the"
  echo "             user's access key into web/.env. Needs aws login as an admin. A full run skips it when not signed"
  echo "             in."
  echo "  gpu        Installs and configures the NVIDIA container toolkit on Fedora (asks for sudo), so the worker"
  echo "             container can use this machine's GPU. A full run skips it without nvidia-smi, and it's skipped"
  echo "             when a GPU container already runs."
  echo
  echo "Then fill in the Clerk keys in web/.env if they are empty, and run pnpm dev from the repo root."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

STEP=${1-}
case $STEP in
  "" | deps | terraform | aws | gpu) ;;
  *)
    usage >&2
    exit 1
    ;;
esac
if [[ $# -gt 1 ]]; then
  usage >&2
  exit 1
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/aws.sh"
source "$ROOT/scripts/lib/confirm.sh"
source "$ROOT/scripts/lib/env.sh"
source "$ROOT/scripts/lib/terraform.sh"

DEV_USER=ai-gaussian-splatter-dev
PROJECT_TAG=ai-gaussian-splatter

# HashiCorp's release signing key. The fingerprint is pinned here rather than trusting whatever the key URL serves, so
# whoever could swap the zip can't also swap the key it's checked against.
HASHICORP_KEY_FINGERPRINT=C874011F0AB405110D02105534365D9472D7468F

# NVIDIA documents no fingerprint for this key, so this is the one its server served on 2026-09-15 rather than an
# independently published value. Pinning it still catches a later swap of the key. Check any mismatch against NVIDIA
# before changing it here.
NVIDIA_FINGERPRINT=C95B321B61E88C1809C4F759DDCAE044F796ECB0
NVIDIA_KEYRING=/etc/pki/rpm-gpg/RPM-GPG-KEY-nvidia-container-toolkit

# Pinned by the multi-arch index digest, so one pin works on any machine and a re-pushed 12.9.1 tag can't swap in a
# different image. The tag is only for readers. Podman pulls by the digest.
CUDA_IMAGE=docker.io/nvidia/cuda:12.9.1-base-ubuntu24.04@sha256:29e5e3425e2e0f5a4e97c9fb4695ba4887cd78210a43cf94c3bcafc6ab01c5e6

# Removed on exit by the trap below. Each step that needs scratch space makes its own directory under it.
SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT

install_deps() {
  pnpm --dir "$ROOT" install
  pnpm --dir "$ROOT/web" install
  uv --directory "$ROOT/worker" sync --group dev
  # splat-pg runs with --restart=always, which rootless Podman honors at boot only through this service.
  systemctl --user enable --now podman-restart.service
}

install_terraform() {
  local tf_version installed='' base zip sums dir status validsig
  tf_version=$(tf_get_required_version)
  if [[ -x $HOME/.local/bin/terraform ]]; then
    installed=$("$HOME/.local/bin/terraform" version)
    installed=${installed%%$'\n'*}
  fi
  if [[ $installed == "Terraform v$tf_version" ]]; then
    echo "terraform: v$tf_version is already in ~/.local/bin."
    return
  fi

  base=https://releases.hashicorp.com/terraform/$tf_version
  zip=terraform_${tf_version}_linux_amd64.zip
  sums=terraform_${tf_version}_SHA256SUMS
  dir=$SCRATCH/terraform
  mkdir "$dir"
  curl -fsSL -o "$dir/$zip" "$base/$zip"
  curl -fsSL -o "$dir/$sums" "$base/$sums"
  curl -fsSL -o "$dir/$sums.sig" "$base/$sums.sig"
  curl -fsSL -o "$dir/hashicorp.asc" https://www.hashicorp.com/.well-known/pgp-key.txt

  # A throwaway keyring, so the check neither depends on nor changes your own GPG setup.
  mkdir -m 700 "$dir/gnupg"
  GNUPGHOME=$dir/gnupg gpg --batch --quiet --import "$dir/hashicorp.asc" 2>/dev/null

  # gpg's VALIDSIG status line ends with the signing key's primary fingerprint, so a good signature from any other key
  # fails this too.
  status=$(GNUPGHOME=$dir/gnupg gpg --batch --status-fd 1 --verify "$dir/$sums.sig" "$dir/$sums" 2>/dev/null || true)
  validsig=$(grep '^\[GNUPG:\] VALIDSIG ' <<<"$status" || true)
  if [[ $validsig != *" $HASHICORP_KEY_FINGERPRINT" ]]; then
    echo "$sums isn't signed by HashiCorp's release key ($HASHICORP_KEY_FINGERPRINT). Nothing was installed." >&2
    exit 1
  fi
  if ! (cd "$dir" && grep " $zip\$" "$sums" | sha256sum --check --quiet --strict); then
    echo "$zip doesn't match its signed checksum. Nothing was installed." >&2
    exit 1
  fi
  echo "Verified $zip against HashiCorp's signed checksums."

  mkdir -p ~/.local/bin
  unzip -o "$dir/$zip" terraform -d ~/.local/bin
  ~/.local/bin/terraform version
}

create_aws_resources() {
  local uploads splats region bucket create_bucket_args=() missing=false key_count keys key_id secret

  aws_require_login

  # The buckets and the region are whatever web/.env names, so the file is created first. A new one is seeded from
  # var.aws_region's default, and an existing one keeps whatever region it already holds, because that is the region
  # web/lib/server/env.ts signs the app's upload URLs for.
  env_create_file "$ROOT/web/.env" "$AWS_ACCOUNT_ID" "$(tf_get_aws_region)"
  uploads=$(env_get "$ROOT/web/.env" UPLOADS_BUCKET)
  splats=$(env_get "$ROOT/web/.env" SPLATS_BUCKET)
  region=$(env_get "$ROOT/web/.env" AWS_REGION)

  for bucket in "$uploads" "$splats"; do
    if ! aws s3api head-bucket --bucket "$bucket" --region "$region" 2>/dev/null; then
      missing=true
    fi
  done
  if ! aws iam get-user --user-name "$DEV_USER" >/dev/null 2>&1; then
    missing=true
  fi
  # Asks only when something is about to be created. A re-run only rewrites settings to the values they already hold.
  if [[ $missing == true ]]; then
    confirm "Create the $uploads and $splats buckets and the $DEV_USER IAM user in $region, account $AWS_ACCOUNT_ID?"
  fi

  # us-east-1 is the one region create-bucket rejects a LocationConstraint for, because it is the API's own default.
  if [[ $region != us-east-1 ]]; then
    create_bucket_args=(--create-bucket-configuration "LocationConstraint=$region")
  fi

  for bucket in "$uploads" "$splats"; do
    if ! aws s3api head-bucket --bucket "$bucket" --region "$region" 2>/dev/null; then
      aws s3api create-bucket --bucket "$bucket" --region "$region" "${create_bucket_args[@]}" >/dev/null
      echo "Created bucket $bucket."
    fi
    aws s3api put-bucket-tagging --bucket "$bucket" --region "$region" \
      --tagging "{\"TagSet\":[{\"Key\":\"Project\",\"Value\":\"$PROJECT_TAG\"}]}"
  done

  # Without these rules the browser blocks both a cross-origin GET and PUT. The presigned URL is valid, so the failure
  # only shows up in the browser console, which distinguishes a CORS-rule 403 from an IAM-policy 403. localhost:3000 is
  # `pnpm dev` and localhost:8000 is scripts/dev/run-web-container.sh.
  aws s3api put-bucket-cors --bucket "$uploads" --region "$region" --cors-configuration '{
    "CORSRules": [{"AllowedMethods": ["PUT"],
                   "AllowedOrigins": ["http://localhost:3000", "http://localhost:8000"],
                   "AllowedHeaders": ["*"]}]
  }'
  aws s3api put-bucket-cors --bucket "$splats" --region "$region" --cors-configuration '{
    "CORSRules": [{"AllowedMethods": ["GET", "HEAD"],
                   "AllowedOrigins": ["http://localhost:3000", "http://localhost:8000"],
                   "AllowedHeaders": ["*"]}]
  }'

  if ! aws iam get-user --user-name "$DEV_USER" >/dev/null 2>&1; then
    aws iam create-user --user-name "$DEV_USER" >/dev/null
    echo "Created IAM user $DEV_USER."
  fi
  aws iam tag-user --user-name "$DEV_USER" --tags "Key=Project,Value=$PROJECT_TAG"
  aws iam put-user-policy --user-name "$DEV_USER" \
    --policy-name dev-buckets --policy-document "{
      \"Version\": \"2012-10-17\",
      \"Statement\": [{
        \"Effect\": \"Allow\",
        \"Action\": [\"s3:PutObject\", \"s3:GetObject\", \"s3:DeleteObject\", \"s3:ListBucket\"],
        \"Resource\": [
          \"arn:aws:s3:::$uploads\", \"arn:aws:s3:::$uploads/*\",
          \"arn:aws:s3:::$splats\", \"arn:aws:s3:::$splats/*\"
        ]
      }]
    }"
  echo "aws: the $uploads and $splats buckets and the $DEV_USER IAM user are in place."

  # Only a user with no key gets one, so a re-run never mints a second. That also covers a run that stopped between
  # creating the user and creating its key.
  key_count=$(aws iam list-access-keys --user-name "$DEV_USER" --query 'length(AccessKeyMetadata)' --output text)
  if [[ $key_count == 0 ]]; then
    keys=$(aws iam create-access-key --user-name "$DEV_USER" \
      --query 'AccessKey.[AccessKeyId, SecretAccessKey]' --output text)
    read -r key_id secret <<<"$keys"
    # A web/.env that already existed keeps its own mode, so it's locked down before the secret goes in.
    chmod 600 "$ROOT/web/.env"
    env_set "$ROOT/web/.env" AWS_ACCESS_KEY_ID "$key_id"
    env_set "$ROOT/web/.env" AWS_SECRET_ACCESS_KEY "$secret"
    echo "Created an access key for $DEV_USER and wrote it into web/.env."
  elif grep -q '^AWS_ACCESS_KEY_ID=replace-with-dev-user-key$' "$ROOT/web/.env"; then
    echo "$DEV_USER already has an access key, but web/.env still holds the placeholder pair." >&2
    echo "AWS shows a secret only once, so this script can't fill it in." >&2
    echo "Copy the pair from another checkout's web/.env, or delete the key (aws iam delete-access-key) and run" >&2
    echo "scripts/dev/setup.sh aws again." >&2
  fi
}

# Succeeds when a container can already see the GPU. The same check the gpu step ends with.
gpu_passthrough_works() {
  # --security-opt=label=disable is required on every GPU run, not just this check. Without it SELinux blocks access to
  # the device nodes and NVML fails with an insufficient permissions error.
  podman run --rm --security-opt=label=disable --device nvidia.com/gpu=all "$CUDA_IMAGE" nvidia-smi
}

setup_gpu() {
  local key=$SCRATCH/nvidia.gpg fingerprint
  if gpu_passthrough_works >/dev/null 2>&1; then
    echo "gpu: containers can already use the GPU."
    return
  fi

  # Left to itself dnf fetches this key over HTTPS and imports whatever comes back, with no prompt under `-y`.
  # Verifying it here and pointing the repository at the local copy is what makes the fingerprint above mean anything.
  curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey -o "$key"

  # The first fpr record is the primary key's, which is what NVIDIA_FINGERPRINT names. The records after it are
  # subkeys.
  fingerprint=$(gpg --show-keys --with-colons "$key" | awk -F: '$1 == "fpr" { print $10; exit }')
  if [[ $fingerprint != "$NVIDIA_FINGERPRINT" ]]; then
    echo "NVIDIA's signing key is $fingerprint, not $NVIDIA_FINGERPRINT. Refusing to install it." >&2
    exit 1
  fi
  sudo install -m 0644 "$key" "$NVIDIA_KEYRING"

  # nvidia-container-toolkit isn't in Fedora's repos or RPM Fusion's. RPM Fusion nonfree carries the NVIDIA GPU driver,
  # but not the toolkit. Upstream's file sets gpgcheck=0, because NVIDIA ships these RPMs unsigned. Its repo_gpgcheck=1
  # is what covers them instead, since the signed metadata carries each package's checksum. The gpgkey rewrite is what
  # aims that check at the key verified above.
  curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo |
    sed "s|^gpgkey=.*|gpgkey=file://$NVIDIA_KEYRING|" |
    sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo >/dev/null
  sudo dnf install -y nvidia-container-toolkit

  # Writes the CDI spec that podman resolves --device nvidia.com/gpu=all against. Generated as root into /etc/cdi even
  # though the containers run rootless.
  sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml

  # nvidia-smi should report the host GPU and driver.
  gpu_passthrough_works
}

case $STEP in
  deps) install_deps ;;
  terraform) install_terraform ;;
  aws) create_aws_resources ;;
  gpu) setup_gpu ;;
  "")
    install_deps
    install_terraform
    if aws sts get-caller-identity >/dev/null 2>&1; then
      create_aws_resources
    else
      echo "aws: skipped, since you're not signed in to AWS. Run aws login, then scripts/dev/setup.sh aws."
    fi
    if command -v nvidia-smi >/dev/null; then
      setup_gpu
    else
      echo "gpu: skipped, since this machine has no nvidia-smi. Local worker runs need an NVIDIA GPU."
    fi
    if grep -q '^CLERK_SECRET_KEY=$' "$ROOT/web/.env" 2>/dev/null; then
      echo "Fill in NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY in web/.env, then run pnpm dev."
    else
      echo "Setup is done. Run pnpm dev from the repo root."
    fi
    ;;
esac
