#!/usr/bin/env bash
# Restore a pg_dump custom-format archive into a target database.
#
#   ./deploy/restore.sh deploy/backups/olb-20261105-030000.dump --db olb_restore_test
#   RESTORE_DB=olb_restore_test ./deploy/restore.sh deploy/backups/olb-20261105-030000.dump
#   ./deploy/restore.sh dump.dump --db olb --force
#
# The live `olb` database is never overwritten unless --force is passed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/docker-compose.yml}"

if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-olb}"
RESTORE_DB="${RESTORE_DB:-}"
RESTORE_CONTAINER="${RESTORE_CONTAINER:-}"
RESTORE_FILE="${RESTORE_FILE:-}"
FORCE=0

usage() {
  cat <<'EOF'
Usage: restore.sh DUMP [options]

Options:
  --db NAME          Target database (required; or set RESTORE_DB)
  --container NAME   Restore into this container instead of the compose postgres service
  --force            Allow restoring over the live database
  -h, --help         Show this help

Environment:
  RESTORE_DB         Same as --db
  RESTORE_CONTAINER  Same as --container
  RESTORE_FILE       Dump path, when it is not the first argument
  POSTGRES_USER      Database user (default: postgres)
  POSTGRES_DB        Live database name guarded by --force (default: olb)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)
      RESTORE_DB="${2:?--db needs a name}"
      shift 2
      ;;
    --container)
      RESTORE_CONTAINER="${2:?--container needs a name}"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$RESTORE_FILE" ]]; then
        echo "unexpected argument: $1" >&2
        exit 2
      fi
      RESTORE_FILE="$1"
      shift
      ;;
  esac
done

if [[ -z "$RESTORE_FILE" ]]; then
  echo "a dump file is required" >&2
  usage >&2
  exit 2
fi
if [[ ! -f "$RESTORE_FILE" ]]; then
  echo "dump not found: $RESTORE_FILE" >&2
  exit 1
fi
if [[ -z "$RESTORE_DB" ]]; then
  echo "RESTORE_DB (or --db) is required" >&2
  usage >&2
  exit 2
fi
if ! [[ "$RESTORE_DB" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "invalid database name: $RESTORE_DB" >&2
  exit 2
fi
if [[ "$RESTORE_DB" == "$POSTGRES_DB" && "$FORCE" != "1" ]]; then
  echo "refusing to overwrite live database '$POSTGRES_DB'; pass --force to allow it" >&2
  exit 1
fi

run_psql() {
  if [[ -n "$RESTORE_CONTAINER" ]]; then
    docker exec -i "$RESTORE_CONTAINER" psql -U "$POSTGRES_USER" -v ON_ERROR_STOP=1 "$@"
  else
    docker compose -f "$COMPOSE_FILE" exec -T postgres \
      psql -U "$POSTGRES_USER" -v ON_ERROR_STOP=1 "$@"
  fi
}

run_pg_restore() {
  if [[ -n "$RESTORE_CONTAINER" ]]; then
    docker exec -i "$RESTORE_CONTAINER" \
      pg_restore -U "$POSTGRES_USER" -d "$RESTORE_DB" \
      --clean --if-exists --no-owner --no-privileges
  else
    docker compose -f "$COMPOSE_FILE" exec -T postgres \
      pg_restore -U "$POSTGRES_USER" -d "$RESTORE_DB" \
      --clean --if-exists --no-owner --no-privileges
  fi
}

echo "checking target database $RESTORE_DB..."
exists="$(run_psql -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$RESTORE_DB'" | tr -d '[:space:]')"

if [[ "$exists" != "1" ]]; then
  echo "creating database $RESTORE_DB..."
  run_psql -d postgres -c "CREATE DATABASE \"$RESTORE_DB\""
else
  echo "database $RESTORE_DB already exists; restoring with --clean --if-exists"
fi

echo "restoring $RESTORE_FILE into $RESTORE_DB..."
run_pg_restore < "$RESTORE_FILE"

tables="$(run_psql -d "$RESTORE_DB" -tAc \
  "SELECT count(*) FROM information_schema.tables \
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE'" | tr -d '[:space:]')"

echo "restore complete: $RESTORE_DB ($tables public tables)"
if [[ "$RESTORE_DB" != "$POSTGRES_DB" ]]; then
  echo "remove the drill database with:"
  echo "  docker exec ${RESTORE_CONTAINER:-<compose-postgres>} dropdb -U $POSTGRES_USER $RESTORE_DB"
fi
