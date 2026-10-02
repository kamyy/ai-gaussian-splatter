#!/usr/bin/env bash
# Starts or deletes the local Postgres container that holds the dev and test databases.
#
# Local development and the database-backed web tests both need this container running, so `pnpm dev` in web/ runs
# `up` itself before it migrates. `down` is for starting over with empty databases.

# Does not migrate. `pnpm dev` and `pnpm db:migrate` migrate the dev database, and Vitest's globalSetup
# (web/tests/migrate-test-db.ts) migrates the test one.

set -euo pipefail

usage() {
  echo "Usage: scripts/dev/db.sh up|down"
  echo
  echo "  up    Creates or starts the splat-pg Postgres container on localhost:5432, waits until it accepts"
  echo "        connections, then creates the empty ai_gaussian_splatter (dev) and ai_gaussian_splatter_test databases"
  echo "        if missing. Does nothing that's already done."
  echo "  down  Asks, then stops and removes splat-pg and its splat-pg-data volume. Both databases go with them. Does"
  echo "        nothing if neither exists."
}

if [[ ${1-} == -h || ${1-} == --help ]]; then
  usage
  exit 0
fi

ACTION=${1-}
if [[ $# -ne 1 || ($ACTION != up && $ACTION != down) ]]; then
  usage >&2
  exit 1
fi

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/confirm.sh"

CONTAINER=splat-pg
VOLUME=splat-pg-data
DEV_DB=ai_gaussian_splatter
TEST_DB=ai_gaussian_splatter_test
READY_TIMEOUT_SEC=30

db_up() {
  local deadline db
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
  # Check readiness over TCP. On a fresh volume the image first runs a temporary init server that listens only on the
  # Unix socket and stops it before starting the real one, so a socket check can report ready too early.
  deadline=$((SECONDS + READY_TIMEOUT_SEC))
  until podman exec "$CONTAINER" pg_isready -h 127.0.0.1 -U postgres >/dev/null; do
    if ((SECONDS >= deadline)); then
      echo "splat-pg did not become ready within ${READY_TIMEOUT_SEC}s" >&2
      exit 1
    fi
    sleep 0.2
  done

  for db in "$DEV_DB" "$TEST_DB"; do
    if ! podman exec "$CONTAINER" psql -U postgres -d postgres -tAc \
      "SELECT datname FROM pg_database WHERE datname='${db}'" | grep -qx "$db"; then
      podman exec "$CONTAINER" createdb -U postgres "$db"
      echo "Created the $db database."
    fi
  done
  echo "Postgres is accepting connections on localhost:5432."
}

db_down() {
  if ! podman container exists "$CONTAINER" && ! podman volume exists "$VOLUME"; then
    echo "No $CONTAINER container or $VOLUME volume to remove."
    return
  fi

  confirm "Delete $CONTAINER and its $VOLUME volume? The dev and test databases go with them."

  if podman container exists "$CONTAINER"; then
    podman stop "$CONTAINER" >/dev/null
    podman rm "$CONTAINER" >/dev/null
    echo "Stopped and removed the $CONTAINER container."
  fi
  if podman volume exists "$VOLUME"; then
    podman volume rm "$VOLUME" >/dev/null
    echo "Deleted the $VOLUME volume, so the dev and test databases are gone."
  fi
}

if [[ $ACTION == up ]]; then
  db_up
else
  db_down
fi
