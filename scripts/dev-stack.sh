#!/usr/bin/env bash
# Local development stack with simulated devices. Never touches the real Envoy,
# the Easee account, or the production database.
#
#   scripts/dev-stack.sh up      # Postgres (podman) + 30 days of history + fake devices + collector
#   scripts/dev-stack.sh down    # stop everything and delete the dev database
#   scripts/dev-stack.sh logs    # follow the collector log
#
# Then run the dashboard against it:
#   echo "DATABASE_URL=postgresql://home_ro:home_ro@127.0.0.1:55432/home" > dashboard/.env
#   dashboard/scripts/dev.sh install   # first time
#   dashboard/scripts/dev.sh dev       # http://localhost:3000
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$ROOT/.dev"            # venv, config, data dir, logs, pids (git-ignored)
PG="home-dev-postgres"
DB_PORT=55432
PY="$RUN/venv/bin/python"

start_bg() {  # $1 name, rest: command (run from collector/)
  local name="$1"; shift
  if [ -f "$RUN/$name.pid" ] && kill -0 "$(cat "$RUN/$name.pid")" 2>/dev/null; then
    echo "$name already running"; return
  fi
  (
    cd "$ROOT/collector"
    nohup "$@" > "$RUN/$name.out" 2>&1 < /dev/null &
    echo $! > "$RUN/$name.pid"   # the python process itself, so `down` can stop it
  )
  echo "started $name (log: .dev/$name.out)"
}

stop_bg() {
  if [ -f "$RUN/$1.pid" ]; then
    kill "$(cat "$RUN/$1.pid")" 2>/dev/null || true
    rm -f "$RUN/$1.pid"
    echo "stopped $1"
  fi
}

case "${1:-}" in
  up)
    mkdir -p "$RUN/sim-data"   # never .dev/data - that holds the real tokens of a local --probe
    if [ ! -x "$PY" ]; then
      python3 -m venv "$RUN/venv"
      "$RUN/venv/bin/pip" install -q -r "$ROOT/collector/requirements.txt"
    fi

    fresh=false
    if ! podman container exists "$PG"; then
      podman run -d --name "$PG" -e POSTGRES_PASSWORD=postgres \
        -p 127.0.0.1:$DB_PORT:5432 docker.io/library/postgres:16 >/dev/null
      fresh=true
    else
      podman start "$PG" >/dev/null
    fi
    # TCP only answers once the image's init phase is over.
    until podman exec "$PG" psql -U postgres -h 127.0.0.1 -qAt -c 'SELECT 1' >/dev/null 2>&1; do sleep 1; done
    if $fresh; then
      # Same roles as production (README.md), with throwaway passwords.
      podman exec -i "$PG" psql -U postgres -h 127.0.0.1 -q -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE home LOGIN PASSWORD 'home';
CREATE DATABASE home OWNER home;
CREATE ROLE home_ro LOGIN PASSWORD 'home_ro';
GRANT CONNECT ON DATABASE home TO home_ro;
\c home
GRANT USAGE ON SCHEMA public TO home_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE home IN SCHEMA public GRANT SELECT ON TABLES TO home_ro;
SQL
      "$PY" "$ROOT/collector/dev/seed.py" --db "postgresql://home:home@127.0.0.1:$DB_PORT/home" --days 30
    fi

    cat > "$RUN/collector.ini" <<EOF
[GENERAL]
DataDir = $RUN/sim-data
[DATABASE]
Url = postgresql://home:home@127.0.0.1:$DB_PORT/home
[ENVOY]
Url = http://127.0.0.1:8099
Token = dev.eyJleHAiOjQxMDI0NDQ4MDB9.dev
[EASEE]
ApiUrl = http://127.0.0.1:8099
Username = dev
Password = dev
EOF
    start_bg fake-devices "$PY" dev/fake_devices.py
    sleep 1
    start_bg collector "$PY" collector.py --config "$RUN/collector.ini"
    echo "Dev database: postgresql://home_ro:home_ro@127.0.0.1:$DB_PORT/home"
    ;;
  down)
    stop_bg collector
    stop_bg fake-devices
    podman rm -f "$PG" >/dev/null 2>&1 && echo "removed $PG" || true
    ;;
  logs)
    tail -f "$RUN/collector.out"
    ;;
  *)
    grep '^#' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
