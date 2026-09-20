#!/usr/bin/env bash
# The root package.json's scripts:check calls it, from the pre-commit hook and CI's lint-format job.

set -euo pipefail

usage() {
  echo "Usage: scripts/dev/shellcheck.sh"
  echo
  echo "Runs shellcheck over every .sh file in scripts/dev/, scripts/prod/, and scripts/lib/."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel)

# Pinned by the multi-arch index digest, so one pin works on any machine and a re-pushed v0.11.0 tag can't swap in a
# different binary. The tag is only for readers. Podman pulls by the digest.
IMAGE=docker.io/koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d

# Host globs expand to $ROOT/.... Strip that prefix so the container, whose cwd is /mnt, still sees scripts/dev/*.sh.
files=()
for f in "$ROOT"/scripts/dev/*.sh "$ROOT"/scripts/prod/*.sh "$ROOT"/scripts/lib/*.sh; do
  files+=("${f#"$ROOT"/}")
done

# label=disable rather than a :Z mount, for the reason in AGENTS.md.
podman run --rm --security-opt label=disable -v "$ROOT:/mnt:ro" -w /mnt "$IMAGE" -x "${files[@]}"
