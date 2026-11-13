#!/usr/bin/env bash
# Build and start the OLB stack as plain Node processes (no Docker, no root).
#
#   ./deploy/up.sh
#   PUBLIC_HOST=127.0.0.1 API_PORT=3401 WEB_PORT=3400 \
#     DATABASE_URL=postgres://postgres:olb@127.0.0.1:5432/olb ./deploy/up.sh
#
# The script builds the contract, the API and the web app, starts the API first,
# waits for /health, then starts web and waits for /. The scorer is part of the
# web app at /score, so there is no separate scorer process. PIDs and logs live
# under deploy/run and deploy/logs, both gitignored. Stop with ./deploy/down.sh.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
WORKSPACE=$(cd -- "$ROOT/.." && pwd)

PUBLIC_HOST=${PUBLIC_HOST:-arch-server.tailc46b97.ts.net}
API_PORT=${API_PORT:-3001}
WEB_PORT=${WEB_PORT:-3000}
DATABASE_URL=${DATABASE_URL:-postgres://postgres:olb@127.0.0.1:5432/olb}
SEED=${SEED:-1}
RUN_DIR=${RUN_DIR:-$SCRIPT_DIR/run}
LOG_DIR=${LOG_DIR:-$SCRIPT_DIR/logs}

API_PUBLIC_URL="http://${PUBLIC_HOST}:${API_PORT}"
WEB_PUBLIC_URL="http://${PUBLIC_HOST}:${WEB_PORT}"

case "$SEED" in
  0 | 1) ;;
  *)
    echo "up.sh: SEED must be 0 or 1 (got '$SEED')" >&2
    exit 1
    ;;
esac

mkdir -p "$RUN_DIR" "$LOG_DIR"

port_busy() {
  ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1$"
}

check_ports() {
  local port
  for port in "$API_PORT" "$WEB_PORT"; do
    if port_busy "$port"; then
      echo "up.sh: port $port is already listening; refusing to start." >&2
      echo "Stop the process on that port (or run ./deploy/down.sh) first." >&2
      exit 1
    fi
  done
}

wait_for_url() {
  local url=$1 label=$2 tries=${3:-60}
  local i
  for i in $(seq 1 "$tries"); do
    if curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "up.sh: $label did not answer $url after ${tries}s" >&2
  return 1
}

stop_started() {
  local pid_file pid
  for pid_file in "$RUN_DIR"/*.pid; do
    [ -e "$pid_file" ] || continue
    pid=$(cat "$pid_file" 2>/dev/null || true)
    [ -n "$pid" ] || {
      rm -f "$pid_file"
      continue
    }
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    rm -f "$pid_file"
  done
}

on_error() {
  local status=$? pid_file started=0
  if [ "$status" -ne 0 ]; then
    for pid_file in "$RUN_DIR"/*.pid; do
      [ -e "$pid_file" ] && started=1
    done
    echo "up.sh failed (exit $status)." >&2
    if [ "$started" -eq 1 ]; then
      echo "Stopping the processes this run started." >&2
      stop_started
    fi
    echo "up.sh: logs in $LOG_DIR" >&2
  fi
  exit "$status"
}
trap on_error EXIT

start_api() {
  (
    cd "$ROOT"
    NODE_ENV=production \
      DATABASE_URL="$DATABASE_URL" \
      PORT="$API_PORT" \
      CORS_ORIGIN="$WEB_PUBLIC_URL,$API_PUBLIC_URL" \
      setsid node dist/main.js >>"$LOG_DIR/api.log" 2>&1 &
    echo $! >"$RUN_DIR/api.pid"
  )
}

# Next nests the standalone server under the Turbopack root, which for the web
# app is the workspace. Accept either layout.
find_server() {
  local app=$1
  if [ -f "$app/.next/standalone/server.js" ]; then
    printf '%s\n' "$app/.next/standalone/server.js"
    return 0
  fi
  local nested
  nested=$(find "$app/.next/standalone" -maxdepth 2 -name server.js -type f 2>/dev/null | head -n 1)
  if [ -n "$nested" ]; then
    printf '%s\n' "$nested"
    return 0
  fi
  echo "up.sh: no standalone server.js under $app/.next/standalone" >&2
  return 1
}

start_next() {
  local name=$1 app=$2 port=$3
  local server standalone
  server=$(find_server "$app")
  standalone=$(dirname "$server")
  # Static assets are not copied into the standalone output by Next.
  rm -rf "$standalone/.next/static"
  mkdir -p "$standalone/.next"
  cp -R "$app/.next/static" "$standalone/.next/static"
  if [ -d "$app/public" ]; then
    rm -rf "$standalone/public"
    cp -R "$app/public" "$standalone/public"
  fi
  (
    cd "$standalone"
    NODE_ENV=production \
      HOSTNAME=0.0.0.0 \
      PORT="$port" \
      API_URL="http://127.0.0.1:${API_PORT}" \
      setsid node "$server" >>"$LOG_DIR/$name.log" 2>&1 &
    echo $! >"$RUN_DIR/$name.pid"
  )
}

check_ports

echo "==> building @olb/contract"
npm --prefix "$WORKSPACE/olb-contract" run build

echo "==> building olb-api"
npm --prefix "$ROOT" run build

echo "==> building olb-web ($API_PUBLIC_URL)"
NEXT_PUBLIC_API_URL="$API_PUBLIC_URL" \
  npm --prefix "$WORKSPACE/olb-web" run build

echo "==> starting api on :$API_PORT"
start_api
wait_for_url "http://127.0.0.1:${API_PORT}/health" "api"

echo "==> starting web on :$WEB_PORT"
start_next web "$WORKSPACE/olb-web" "$WEB_PORT"
wait_for_url "http://127.0.0.1:${WEB_PORT}/" "web"

if [ "$SEED" = "1" ]; then
  echo "==> seeding league catalog and demo users (idempotent)"
  DATABASE_URL="$DATABASE_URL" npm --prefix "$ROOT" run seed:league
  echo "==> seeding the completed league game (idempotent)"
  API_URL="http://127.0.0.1:${API_PORT}" npm --prefix "$ROOT" run seed:full
else
  echo "==> SEED=0, skipping seeds"
fi

trap - EXIT

echo
echo "OLB stack is up."
echo "  web     $WEB_PUBLIC_URL  (scorer at $WEB_PUBLIC_URL/score)"
echo "  api     $API_PUBLIC_URL  (health: $API_PUBLIC_URL/health)"
echo "  pids    $RUN_DIR/{api,web}.pid"
echo "  logs    $LOG_DIR/{api,web}.log"
echo "Stop with: $SCRIPT_DIR/down.sh"
