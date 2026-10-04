#!/bin/bash
# Deploy to unRAID: rsync the source to the server, then build and (re)run the
# containers over SSH with plain docker (same pattern as Wallbox-Steuerung and
# Finance-Tracking).
#
#   ./deploy.sh              # collector + dashboard
#   ./deploy.sh collector
#   ./deploy.sh dashboard
#
# One-time prerequisites (database, config.ini, dashboard.env): see README.md.
# Code and state are separated: images hold the code, the collector's
# config.ini, tokens and logs live in $COLLECTOR_DATA mounted at /data.
set -e

UNRAID="root@192.168.178.70"
BASE="/mnt/user/appdata/home-dashboard"
SRC_DIR="$BASE/src"                                        # code staging area for the image builds
COLLECTOR_DATA="/mnt/cache/appdata/home-dashboard/collector" # config.ini, tokens, logs, heartbeat
DASHBOARD_ENV="$BASE/dashboard.env"                        # DATABASE_URL (read-only role), HOME_TZ
DASHBOARD_PORT=4010
TZ_VALUE="Europe/Berlin"

TARGET="${1:-all}"
cd "$(dirname "$0")"

echo "Syncing source -> $UNRAID:$SRC_DIR ..."
ssh "$UNRAID" "mkdir -p '$SRC_DIR' '$COLLECTOR_DATA'"
rsync -av --delete \
  --exclude='.git' --exclude='.dev' --exclude='node_modules' --exclude='.next' \
  --exclude='__pycache__' --exclude='*.pyc' --exclude='*.log' --exclude='*.log.*' \
  --exclude='config.ini' --exclude='.env' --exclude='*.env' \
  ./ "$UNRAID:$SRC_DIR/"

deploy_collector() {
  if ! ssh "$UNRAID" "test -f '$COLLECTOR_DATA/config.ini'"; then
    echo "ERROR: $COLLECTOR_DATA/config.ini is missing on the server - see README.md." >&2
    exit 1
  fi
  echo "=== home-collector ==="
  # set -e + separate lines: a failed build leaves the running container untouched.
  ssh "$UNRAID" "set -e
    cd '$SRC_DIR/collector'
    docker build -t home-collector:latest .
    docker stop home-collector 2>/dev/null || true
    docker rm home-collector 2>/dev/null || true
    docker run -d \
      --name home-collector \
      --restart unless-stopped \
      -e TZ=${TZ_VALUE} \
      -v '${COLLECTOR_DATA}:/data' \
      home-collector:latest
  "
}

deploy_dashboard() {
  if ! ssh "$UNRAID" "test -f '$DASHBOARD_ENV'"; then
    echo "ERROR: $DASHBOARD_ENV is missing on the server - see README.md." >&2
    exit 1
  fi
  echo "=== home-dashboard ==="
  ssh "$UNRAID" "set -e
    cd '$SRC_DIR/dashboard'
    docker build -t home-dashboard:latest .
    docker stop home-dashboard 2>/dev/null || true
    docker rm home-dashboard 2>/dev/null || true
    docker run -d \
      --name home-dashboard \
      --restart unless-stopped \
      -e TZ=${TZ_VALUE} \
      --env-file '${DASHBOARD_ENV}' \
      -p ${DASHBOARD_PORT}:3000 \
      home-dashboard:latest
  "
}

case "$TARGET" in
  all)       deploy_collector; deploy_dashboard ;;
  collector) deploy_collector ;;
  dashboard) deploy_dashboard ;;
  *)         echo "usage: $0 [all|collector|dashboard]" >&2; exit 1 ;;
esac

echo
echo "Done. Dashboard: http://192.168.178.70:${DASHBOARD_PORT}"
echo "Collector logs:  ssh $UNRAID docker logs -f home-collector"
