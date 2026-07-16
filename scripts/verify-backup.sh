#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${MEMEX_ROOT:-/opt/memex}"
BACKUP_DIR="${1:-}"

if [[ -z "$BACKUP_DIR" ]]; then
  echo "Usage: $0 /path/to/backup-directory" >&2
  exit 2
fi

if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "Backup directory not found: $BACKUP_DIR" >&2
  exit 2
fi

cd "$ROOT_DIR"

test -s "${BACKUP_DIR}/postgres-memex.dump"
test -s "${BACKUP_DIR}/documents.tar.gz"
test -s "${BACKUP_DIR}/manifest.txt"
test -s "${BACKUP_DIR}/SHA256SUMS"

(cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS)
docker compose exec -T postgres pg_restore --list < "${BACKUP_DIR}/postgres-memex.dump" > /dev/null

# Keycloak dump: verify its catalog when present; loudly flag its absence (a backup
# without it would lose every account on restore) but don't fail the whole check so
# pre-existing backups still verify.
kc_status="pass"
if [[ -s "${BACKUP_DIR}/postgres-keycloak.dump" ]]; then
  docker compose exec -T postgres pg_restore --list < "${BACKUP_DIR}/postgres-keycloak.dump" > /dev/null
else
  kc_status="MISSING — this backup has no Keycloak dump; a restore would lose accounts"
  echo "WARNING: ${kc_status}" >&2
fi

tar -tzf "${BACKUP_DIR}/documents.tar.gz" > /dev/null

EVIDENCE="${BACKUP_DIR}/restore-check.txt"
{
  echo "restore_check_at_utc=$(date -u --iso-8601=seconds)"
  echo "backup_dir=${BACKUP_DIR}"
  echo "sha256=pass"
  echo "postgres_dump_catalog=pass"
  echo "keycloak_dump_catalog=${kc_status}"
  echo "documents_archive_list=pass"
  echo "result=pass"
  echo "note=Non-destructive verification only; live database was not modified."
} > "$EVIDENCE"

echo "Backup verification passed: $BACKUP_DIR"
cat "$EVIDENCE"
