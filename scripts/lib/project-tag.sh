# shellcheck shell=bash
# Sourced by the scripts in scripts/dev/ and scripts/prod/ that tag AWS resources they create. Not meant to be run
# directly.

# Sets PROJECT_TAG to local.project_tag from infra/locals.tf, the same value infra/providers.tf's default_tags applies.

ROOT=$(git rev-parse --show-toplevel)
PROJECT_TAG=$(grep -oP 'project_tag\s*=\s*"\K[^"]+' "$ROOT/infra/locals.tf" || true)
if [[ -z $PROJECT_TAG ]]; then
  echo "Can't read local.project_tag from infra/locals.tf." >&2
  exit 1
fi
