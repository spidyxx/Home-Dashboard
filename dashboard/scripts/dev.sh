#!/usr/bin/env bash
# Run Node tooling inside a container via podman — no Node install on the host
# (same approach as Finance-Tracking).
#
#   scripts/dev.sh install          # npm install
#   scripts/dev.sh dev              # next dev on http://localhost:3000 (also on the LAN)
#   scripts/dev.sh build            # next build
#   scripts/dev.sh npm <args...>    # arbitrary npm command
#   scripts/dev.sh shell            # interactive shell
#
# Next.js loads .env from the mounted project dir. The container shares the
# host network, so DATABASE_URL works the same as on the host (127.0.0.1 for
# scripts/dev-stack.sh, 192.168.178.70 for the server).
set -euo pipefail

IMAGE="docker.io/library/node:22-slim"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_VOL="home-dashboard-npm-cache"

run() {
  podman run --rm -it \
    -v "$PROJECT_DIR":/app:Z \
    -v "$CACHE_VOL":/root/.npm \
    -e NEXT_TELEMETRY_DISABLED=1 \
    -w /app \
    "$@"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  install) run "$IMAGE" npm install ;;
  dev)     run --network host "$IMAGE" sh -c 'npm run dev -- -H 0.0.0.0 -p 3000' ;;
  build)   run "$IMAGE" npm run build ;;
  npm)     run "$IMAGE" npm "$@" ;;
  shell)   run "$IMAGE" bash ;;
  *)       grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
