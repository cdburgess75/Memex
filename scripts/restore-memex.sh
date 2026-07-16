#!/usr/bin/env bash
#
# Restore a Memex backup produced by scripts/backup-memex.sh or the in-app backup.
# Restores the memex + keycloak databases and the documents directory.
#
# DESTRUCTIVE: overwrites the current databases and documents. Requires typing
# "restore" to confirm unless --force is passed.
#
#   ./restore-memex.sh /srv/memex-backups/20260716T031500Z
#   ./restore-memex.sh /path/to/memex-backup-20260716T031500Z.tar.gz
#   ./restore-memex.sh --force <src>
#
# Note: pg_restore --clean may emit benign "does not exist, skipping" notices on a
# fresh database. Drill this against a scratch stack before relying on it in anger.
set -euo pipefail

ROOT_DIR="${MEMEX_ROOT:-/opt/memex}"
DOCS_DIR="${MEMEX_DOCS_DIR:-/srv/memex-documents}"

FORCE=0
SRC=""
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    *) SRC="$a" ;;
  esac
done

if [[ -z "$SRC" ]]; then
  echo "Usage: $0 [--force] /path/to/backup-dir-or-archive" >&2
  exit 2
fi

cd "$ROOT_DIR"

# Resolve SRC to a directory holding the dumps. A .tar.gz (in-app backup format) is
# extracted to a temp dir first.
CLEANUP=""
cleanup() { [[ -n "$CLEANUP" ]] && rm -rf "$CLEANUP"; }
trap cleanup EXIT

if [[ -d "$SRC" ]]; then
  BK="$SRC"
elif [[ -f "$SRC" ]]; then
  BK="$(mktemp -d)"; CLEANUP="$BK"
  tar -xzf "$SRC" -C "$BK"
else
  echo "Not found: $SRC" >&2
  exit 2
fi

[[ -s "${BK}/postgres-memex.dump" ]] || { echo "Missing postgres-memex.dump in $BK" >&2; exit 2; }

if [[ "$FORCE" != "1" ]]; then
  echo "About to RESTORE from: $SRC"
  echo "This OVERWRITES the current memex + keycloak databases and documents in $DOCS_DIR."
  printf 'Type "restore" to proceed: '
  read -r reply
  [[ "$reply" == "restore" ]] || { echo "Aborted."; exit 1; }
fi

echo "Stopping app and keycloak so their databases are quiescent…"
docker compose stop app keycloak

echo "Restoring memex database…"
docker compose exec -T postgres pg_restore -U memex -d memex --clean --if-exists --no-owner < "${BK}/postgres-memex.dump"

if [[ -s "${BK}/postgres-keycloak.dump" ]]; then
  echo "Restoring keycloak database…"
  docker compose exec -T postgres pg_restore -U memex -d keycloak --clean --if-exists --no-owner < "${BK}/postgres-keycloak.dump"
else
  echo "WARNING: no postgres-keycloak.dump in this backup — Keycloak accounts will NOT be restored." >&2
fi

if [[ -s "${BK}/documents.tar.gz" ]]; then
  echo "Restoring documents into $DOCS_DIR…"
  mkdir -p "$DOCS_DIR"
  tar -C "$DOCS_DIR" -xzf "${BK}/documents.tar.gz"
fi

echo "Starting app and keycloak…"
docker compose up -d app keycloak

echo "Restore complete from: $SRC"
