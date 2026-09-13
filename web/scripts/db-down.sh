#!/usr/bin/env bash
# Stops and removes splat-pg and the splat-pg-data volume. Dev and test databases are gone.
# A missing container or volume is a no-op.
set -euo pipefail

CONTAINER=splat-pg
VOLUME=splat-pg-data

if podman container exists "$CONTAINER"; then
  podman stop "$CONTAINER" >/dev/null
  podman rm "$CONTAINER" >/dev/null
fi

if podman volume exists "$VOLUME"; then
  podman volume rm "$VOLUME" >/dev/null
fi
