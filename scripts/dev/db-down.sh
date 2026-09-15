#!/usr/bin/env bash
# Stops and removes splat-pg and the splat-pg-data volume. Dev and test databases are gone.
# A missing container or volume is a no-op.

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
source "$ROOT/scripts/lib/confirm.sh"

CONTAINER=splat-pg
VOLUME=splat-pg-data

if ! podman container exists "$CONTAINER" && ! podman volume exists "$VOLUME"; then
  echo "No $CONTAINER container or $VOLUME volume to remove."
  exit 0
fi

confirm "Delete $CONTAINER and its $VOLUME volume? The dev and test databases go with them."

if podman container exists "$CONTAINER"; then
  podman stop "$CONTAINER" >/dev/null
  podman rm "$CONTAINER" >/dev/null
  echo "Stopped and removed the $CONTAINER container."
else
  echo "No $CONTAINER container to remove."
fi

if podman volume exists "$VOLUME"; then
  podman volume rm "$VOLUME" >/dev/null
  echo "Deleted the $VOLUME volume, so the dev and test databases are gone."
else
  echo "No $VOLUME volume to delete."
fi
