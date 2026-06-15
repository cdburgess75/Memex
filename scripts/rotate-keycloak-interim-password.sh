#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${MEMEX_ROOT:-/opt/memex}"
ENV_FILE="${MEMEX_ENV_FILE:-${ROOT_DIR}/.env}"
REALM="${KEYCLOAK_REALM:-memex}"
TARGET_EMAIL="${MEMEX_INTERIM_ADMIN_EMAIL:-dave@ptechllc.com}"
OUT_FILE="${MEMEX_INTERIM_PASSWORD_FILE:-/root/memex-interim-app-password.txt}"
TEMPORARY="${MEMEX_INTERIM_PASSWORD_TEMPORARY:-false}"

if [[ ! -d "$ROOT_DIR" ]]; then
  echo "Memex root not found: $ROOT_DIR" >&2
  exit 2
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

KEYCLOAK_ADMIN_USER="${KEYCLOAK_ADMIN_USER:-admin}"
if [[ -z "${KEYCLOAK_ADMIN_PASSWORD:-}" ]]; then
  echo "KEYCLOAK_ADMIN_PASSWORD is required in ${ENV_FILE}" >&2
  exit 2
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to generate the replacement password" >&2
  exit 2
fi

cd "$ROOT_DIR"

NEW_PASSWORD="$(openssl rand -hex 24)"

docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8080 \
  --realm master \
  --user "$KEYCLOAK_ADMIN_USER" \
  --password "$KEYCLOAK_ADMIN_PASSWORD" >/dev/null

USER_ID="$(docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh get users \
  -r "$REALM" \
  -q "email=${TARGET_EMAIL}" \
  --fields id \
  --format csv \
  --noquotes | tr -d '\r' | awk 'NR == 2 { print $1 }')"

if [[ -z "$USER_ID" ]]; then
  echo "No Keycloak user found for ${TARGET_EMAIL} in realm ${REALM}" >&2
  exit 1
fi

docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh set-password \
  -r "$REALM" \
  --userid "$USER_ID" \
  --new-password "$NEW_PASSWORD" \
  --temporary "$TEMPORARY" >/dev/null

umask 077
{
  echo "Memex interim app credential"
  echo "rotated_at_utc=$(date -u --iso-8601=seconds)"
  echo "realm=${REALM}"
  echo "email=${TARGET_EMAIL}"
  echo "temporary=${TEMPORARY}"
  echo "password=${NEW_PASSWORD}"
  echo "note=Move this value to the operator password manager, then remove this file."
} > "$OUT_FILE"
chmod 600 "$OUT_FILE"

echo "Rotated Keycloak password for ${TARGET_EMAIL} in realm ${REALM}."
echo "New password stored root-only at ${OUT_FILE}."
