#!/usr/bin/env bash
# Needs the NVIDIA GPU driver already installed. Asks for sudo.

set -euo pipefail

usage() {
  echo "Usage: scripts/dev/setup-gpu-passthrough.sh"
  echo
  echo "One-time Fedora setup that lets rootless Podman pass the host's NVIDIA GPU into the worker container."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

# NVIDIA documents no fingerprint for this key, so this is the one its server served on 2026-09-15 rather than an
# independently published value. Pinning it still catches a later swap of the key. Check any mismatch against NVIDIA
# before changing it here.
NVIDIA_FINGERPRINT=C95B321B61E88C1809C4F759DDCAE044F796ECB0
NVIDIA_KEYRING=/etc/pki/rpm-gpg/RPM-GPG-KEY-nvidia-container-toolkit

# Pinned by the multi-arch index digest, so one pin works on any machine and a re-pushed 12.9.1 tag can't swap in a
# different image. The tag is only for readers. Podman pulls by the digest.
CUDA_IMAGE=docker.io/nvidia/cuda:12.9.1-base-ubuntu24.04@sha256:29e5e3425e2e0f5a4e97c9fb4695ba4887cd78210a43cf94c3bcafc6ab01c5e6

# Left to itself dnf fetches this key over HTTPS and imports whatever comes back, with no prompt under `-y`. Verifying
# it here and pointing the repository at the local copy is what makes the fingerprint above mean anything.
key=$(mktemp)
trap 'rm -f "$key"' EXIT
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey -o "$key"

# The first fpr record is the primary key's, which is what NVIDIA_FINGERPRINT names. The records after it are subkeys.
fingerprint=$(gpg --show-keys --with-colons "$key" | awk -F: '$1 == "fpr" { print $10; exit }')
if [[ $fingerprint != "$NVIDIA_FINGERPRINT" ]]; then
  echo "NVIDIA's signing key is $fingerprint, not $NVIDIA_FINGERPRINT. Refusing to install it." >&2
  exit 1
fi
sudo install -m 0644 "$key" "$NVIDIA_KEYRING"

# nvidia-container-toolkit isn't in Fedora's repos or RPM Fusion's. RPM Fusion nonfree carries the NVIDIA GPU driver,
# but not the toolkit. Upstream's file sets gpgcheck=0, because NVIDIA ships these RPMs unsigned. Its repo_gpgcheck=1 is
# what covers them instead, since the signed metadata carries each package's checksum. The gpgkey rewrite is what aims
# that check at the key verified above.
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo |
  sed "s|^gpgkey=.*|gpgkey=file://$NVIDIA_KEYRING|" |
  sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo >/dev/null
sudo dnf install -y nvidia-container-toolkit

# Writes the CDI spec that podman resolves --device nvidia.com/gpu=all against. Generated as root into /etc/cdi even
# though the containers run rootless.
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml

# Verifies the passthrough against a stock CUDA image. nvidia-smi should report the host GPU and driver.
# --security-opt=label=disable is required on every GPU run, not just this check. Without it SELinux blocks access to
# the device nodes and NVML fails with an insufficient permissions error.
podman run --rm --security-opt=label=disable --device nvidia.com/gpu=all \
  "$CUDA_IMAGE" nvidia-smi
