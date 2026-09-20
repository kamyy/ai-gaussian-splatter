#!/usr/bin/env bash
# Does not migrate. Vitest's globalSetup (web/tests/migrate-test-db.ts) applies web/drizzle/ to TEST_DATABASE_URL.

set -euo pipefail

usage() {
  echo "Usage: scripts/dev/db-up.sh"
  echo
  echo "Starts the splat-pg Postgres container if needed, then creates the empty dev and test databases."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

CONTAINER=splat-pg
VOLUME=splat-pg-data
DEV_DB=ai_gaussian_splatter
TEST_DB=ai_gaussian_splatter_test

if ! podman container exists "$CONTAINER"; then
  podman run -d --name "$CONTAINER" --restart=always \
    -p 5432:5432 \
    -v "$VOLUME":/var/lib/postgresql \
    -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB="$DEV_DB" \
    postgres:18 >/dev/null
  echo "Created the $CONTAINER container. Its data, including the $DEV_DB database, lives in $VOLUME."
elif [[ $(podman container inspect -f '{{.State.Running}}' "$CONTAINER") == true ]]; then
  echo "$CONTAINER is already running."
else
  podman start "$CONTAINER" >/dev/null
  echo "Started the existing $CONTAINER container."
fi

# pg_isready, psql, and createdb are in the postgres:18 image. Assume the host has no Postgres client.
# Check readiness over TCP. On a fresh volume the image first runs a temporary init server that listens only on the Unix
# socket and stops it before starting the real one, so a socket check can report ready too early.
READY_TIMEOUT_SEC=30
deadline=$((SECONDS + READY_TIMEOUT_SEC))
until podman exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null; do
  if ((SECONDS >= deadline)); then
    echo "splat-pg did not become ready within ${READY_TIMEOUT_SEC}s" >&2
    exit 1
  fi
  sleep 0.2
done
echo "Postgres is accepting connections on localhost:5432."

for db in "$DEV_DB" "$TEST_DB"; do
  if podman exec "$CONTAINER" psql -U postgres -d postgres -tAc \
    "SELECT datname FROM pg_database WHERE datname='${db}'" | grep -qx "$db"; then
    echo "The $db database already exists."
  else
    podman exec "$CONTAINER" createdb -U postgres "$db"
    echo "Created the $db database."
  fi
done
