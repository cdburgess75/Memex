#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${MEMEX_ROOT:-/opt/memex}"
DOCS_DIR="${MEMEX_DOCS_DIR:-/srv/memex-documents}"
BACKUP_ROOT="${MEMEX_BACKUP_DIR:-/srv/memex-backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${BACKUP_ROOT}/${STAMP}"

mkdir -p "$DEST"
cd "$ROOT_DIR"

echo "Creating Memex backup: $DEST"

docker compose exec -T postgres pg_dump -U memex -d memex -Fc > "${DEST}/postgres-memex.dump"
# Keycloak's users, credentials, and sessions live in a separate `keycloak` database
# on the same server — dump it too, or a restore loses every account created since
# install (the seed realm is all that comes back otherwise).
docker compose exec -T postgres pg_dump -U memex -d keycloak -Fc > "${DEST}/postgres-keycloak.dump"
tar -C "$DOCS_DIR" --exclude='./lost+found' -czf "${DEST}/documents.tar.gz" .

{
  echo "backup_id=${STAMP}"
  echo "created_at_utc=$(date -u --iso-8601=seconds)"
  echo "root_dir=${ROOT_DIR}"
  echo "documents_dir=${DOCS_DIR}"
  echo "postgres_dump=postgres-memex.dump"
  echo "postgres_dump_keycloak=postgres-keycloak.dump"
  echo "documents_archive=documents.tar.gz"
  echo "note=Local backup staging only; copy off-host for real backup coverage."
} > "${DEST}/manifest.txt"

(cd "$DEST" && sha256sum postgres-memex.dump postgres-keycloak.dump documents.tar.gz manifest.txt > SHA256SUMS)

echo "Backup complete: $DEST"
du -sh "$DEST"
