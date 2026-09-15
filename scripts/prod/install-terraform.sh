#!/usr/bin/env bash
# Installs the exact Terraform release infra/providers.tf pins as a standalone binary in ~/.local/bin. It checks
# HashiCorp's signature on the release's checksum file first, then the zip against that checksum, and installs nothing
# if either check fails.

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/terraform.sh"

# HashiCorp's release signing key. The fingerprint is pinned here rather than trusting whatever the key URL serves, so
# whoever could swap the zip can't also swap the key it's checked against.
HASHICORP_KEY_FINGERPRINT=C874011F0AB405110D02105534365D9472D7468F

TF_VERSION=$(tf_required_version)
BASE=https://releases.hashicorp.com/terraform/$TF_VERSION
ZIP=terraform_${TF_VERSION}_linux_amd64.zip
SUMS=terraform_${TF_VERSION}_SHA256SUMS
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cd "$TMP"
curl -fsSL -O "$BASE/$ZIP" -O "$BASE/$SUMS" -O "$BASE/$SUMS.sig"
curl -fsSL -o hashicorp.asc https://www.hashicorp.com/.well-known/pgp-key.txt

# A throwaway keyring, so the check neither depends on nor changes your own GPG setup.
export GNUPGHOME=$TMP/gnupg
mkdir -m 700 "$GNUPGHOME"
gpg --batch --quiet --import hashicorp.asc 2>/dev/null

# gpg's VALIDSIG status line ends with the signing key's primary fingerprint, so a good signature from any other key
# fails this too.
status=$(gpg --batch --status-fd 1 --verify "$SUMS.sig" "$SUMS" 2>/dev/null || true)
validsig=$(grep '^\[GNUPG:\] VALIDSIG ' <<<"$status" || true)
if [[ $validsig != *" $HASHICORP_KEY_FINGERPRINT" ]]; then
  echo "$SUMS isn't signed by HashiCorp's release key ($HASHICORP_KEY_FINGERPRINT). Nothing was installed." >&2
  exit 1
fi
if ! grep " $ZIP\$" "$SUMS" | sha256sum --check --quiet --strict; then
  echo "$ZIP doesn't match its signed checksum. Nothing was installed." >&2
  exit 1
fi
echo "Verified $ZIP against HashiCorp's signed checksums."

mkdir -p ~/.local/bin
unzip -o "$ZIP" terraform -d ~/.local/bin
~/.local/bin/terraform version
