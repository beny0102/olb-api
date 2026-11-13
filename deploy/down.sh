#!/usr/bin/env bash
# Stop the processes started by deploy/up.sh.
#
# The PIDs written by up.sh are session leaders (setsid), so each app is stopped
# as a process group. Missing or stale PID files are fine; running this twice is
# safe. RUN_DIR must match the value used by up.sh.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
RUN_DIR=${RUN_DIR:-$SCRIPT_DIR/run}

stopped=0

stop_pid() {
  local name=$1 pid_file=$2 pid
  [ -f "$pid_file" ] || return 0
  pid=$(cat "$pid_file" 2>/dev/null || true)
  rm -f "$pid_file"
  [ -n "$pid" ] || return 0

  if ! kill -0 "$pid" 2>/dev/null; then
    echo "down.sh: $name (pid $pid) is not running"
    return 0
  fi

  echo "down.sh: stopping $name (pid $pid)"
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true

  local i
  for i in $(seq 1 100); do
    if ! kill -0 "$pid" 2>/dev/null; then
      stopped=$((stopped + 1))
      return 0
    fi
    sleep 0.1
  done

  echo "down.sh: $name did not exit after 10s, sending SIGKILL" >&2
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  stopped=$((stopped + 1))
}

# Reverse start order: apps first, API last.
stop_pid scorer "$RUN_DIR/scorer.pid"
stop_pid web "$RUN_DIR/web.pid"
stop_pid api "$RUN_DIR/api.pid"

if [ "$stopped" -eq 0 ]; then
  echo "down.sh: nothing to stop"
else
  echo "down.sh: stopped $stopped process group(s)"
fi
