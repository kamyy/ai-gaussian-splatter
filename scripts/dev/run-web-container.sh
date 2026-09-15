#!/usr/bin/env bash
# Builds the splat-web image production runs and serves it on http://localhost:8000 in place of `pnpm dev`. Needs
# splat-pg up (scripts/dev/db-up.sh) and a filled-in web/.env. Replaces any splat-web container from an earlier run.

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/env-files.sh"

# The Clerk publishable key is a build arg because it's inlined into the browser bundle at build time. An empty or
# malformed key makes clerkMiddleware() 500 every matched route. Use a Clerk test key (pk_test_...), not a live one.
PUBLISHABLE_KEY=$(get_env_var "$ROOT/web/.env" NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)
if [[ $PUBLISHABLE_KEY != pk_* ]]; then
  echo "Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY in web/.env to a pk_test_... key." >&2
  exit 1
fi

podman build --target web --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="$PUBLISHABLE_KEY" -t splat-web:test "$ROOT/web"

podman rm -f --ignore splat-web >/dev/null

# web/.env supplies most variables. DATABASE_HOST and APP_PUBLIC_URL override its values. host.containers.internal is
# Podman's built-in alias for the host, which is where splat-pg publishes its port, so no shared network is needed.
podman run -d --name splat-web -p 8000:8000 --env-file "$ROOT/web/.env" \
  -e DATABASE_HOST=host.containers.internal \
  -e APP_PUBLIC_URL=http://localhost:8000 \
  splat-web:test >/dev/null

# 127.0.0.1 rather than localhost, because the port is published on 0.0.0.0 and localhost can resolve to ::1 first.
READY_TIMEOUT_SEC=30
deadline=$((SECONDS + READY_TIMEOUT_SEC))
until curl -fs http://127.0.0.1:8000/api/v1/healthz; do
  if ((SECONDS >= deadline)); then
    echo "splat-web did not answer /api/v1/healthz within ${READY_TIMEOUT_SEC}s. See: podman logs splat-web" >&2
    exit 1
  fi
  sleep 0.5
done

echo
echo "splat-web is up at http://localhost:8000"
