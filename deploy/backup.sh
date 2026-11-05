#!/usr/bin/env bash
# Dump the compose Postgres database into deploy/backups with a timestamp.
#
#   ./deploy/backup.sh
#   BACKUP_CONTAINER=olb-postgres ./deploy/backup.sh
#   RETENTION_DAYS=14 ./deploy/backup.sh
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
BACKUP_DIR="${BACKUP_DIR:-$SCRIPT_DIR/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
BACKUP_CONTAINER="${BACKUP_CONTAINER:-}"

usage() {
  cat <<'EOF'
Usage: backup.sh [options]

Options:
  --container NAME   Dump from this container instead of the compose postgres service
  --retention DAYS   Keep dumps for this many days (default: 7)
  -h, --help         Show this help

Environment:
  BACKUP_DIR         Output directory (default: deploy/backups)
  BACKUP_CONTAINER   Same as --container
  POSTGRES_USER      Database user (default: postgres)
  POSTGRES_DB        Database name (default: olb)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --container)
      BACKUP_CONTAINER="${2:?--container needs a name}"
      shift 2
      ;;
    --retention)
      RETENTION_DAYS="${2:?--retention needs a number of days}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  echo "retention must be a non-negative integer: $RETENTION_DAYS" >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%d-%H%M%S)"
file="$BACKUP_DIR/olb-$stamp.dump"
tmp="$file.partial"

if [[ -e "$file" ]]; then
  echo "backup already exists: $file" >&2
  exit 1
fi

cleanup() {
  rm -f "$tmp"
}
trap cleanup EXIT

echo "dumping $POSTGRES_DB from ${BACKUP_CONTAINER:-compose postgres}..."
if [[ -n "$BACKUP_CONTAINER" ]]; then
  docker exec -i "$BACKUP_CONTAINER" \
    pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > "$tmp"
else
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > "$tmp"
fi

if [[ ! -s "$tmp" ]]; then
  echo "pg_dump produced an empty file" >&2
  exit 1
fi

mv "$tmp" "$file"
trap - EXIT

# Retention is counted in days, not runs: a quiet week must not erase history.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'olb-*.dump' \
  -mtime +"$RETENTION_DAYS" -print -delete

echo "backup written: $file ($(du -h "$file" | cut -f1))"
echo "retention: ${RETENTION_DAYS} days"
