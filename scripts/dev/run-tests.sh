#!/usr/bin/env bash
# The Postgres-backed web tests need splat-pg up (scripts/dev/db-up.sh) and TEST_DATABASE_URL in web/.env.

set -euo pipefail

usage() {
  echo "Usage: scripts/dev/run-tests.sh"
  echo
  echo "Runs every lint, typecheck, and test suite in the repo."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/terraform.sh"

pnpm --dir "$ROOT" biome:ci
pnpm --dir "$ROOT" run scripts:check
pnpm --dir "$ROOT" run web:check
pnpm --dir "$ROOT" run worker:check
pnpm --dir "$ROOT" run infra:check

pnpm --dir "$ROOT/web" test
pnpm --dir "$ROOT/web" test:e2e
uv --directory "$ROOT/worker" run pytest -v

TERRAFORM=$(tf_get_bin)
"$TERRAFORM" -chdir="$ROOT/infra" test
