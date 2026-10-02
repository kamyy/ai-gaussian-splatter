#!/usr/bin/env bash
# Checks that infra/'s Terraform is formatted and valid.
#
# Uses the Terraform CLI version infra/providers.tf pins, not whichever terraform is first on PATH. It never contacts
# AWS.

# The root package.json's infra:lint runs this, from the pre-commit hook, CI's infra job, and the root `pnpm lint`.

set -euo pipefail

usage() {
  echo "Usage: scripts/dev/terraform-check.sh"
  echo
  echo "Runs terraform fmt -check, init -backend=false, and validate on infra/."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/terraform.sh"

TERRAFORM=$(tf_get_bin)

"$TERRAFORM" -chdir="$ROOT/infra" fmt -check -recursive

# terraform init -backend=false requires an unexpired aws login session if infra/.terraform/terraform.tfstate exists,
# so delete the file. scripts/lib/terraform.sh's tf_init passes -reconfigure, so these scripts write it again on their
# next init against the live account:
#   - scripts/prod/teardown.sh
#   - scripts/prod/terraform-plan.sh
rm -f "$ROOT/infra/.terraform/terraform.tfstate"
"$TERRAFORM" -chdir="$ROOT/infra" init -backend=false -input=false

"$TERRAFORM" -chdir="$ROOT/infra" validate
