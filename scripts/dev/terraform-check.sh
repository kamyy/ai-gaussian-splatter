#!/usr/bin/env bash
# fmt, init -backend=false, and validate. The root package.json's infra:check calls it, from the pre-commit hook and
# CI's infra job.

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/terraform.sh"

TERRAFORM=$(tf_get_bin)

"$TERRAFORM" -chdir="$ROOT/infra" fmt -check -recursive
"$TERRAFORM" -chdir="$ROOT/infra" init -backend=false -input=false
"$TERRAFORM" -chdir="$ROOT/infra" validate
