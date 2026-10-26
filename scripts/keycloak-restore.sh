#!/usr/bin/env bash
# Put the Keycloak database back as a keycloak-predump dump has it, then start the Keycloak
# this directory's docker-compose.yml names. This is how Keycloak goes back a version: an
# older Keycloak cannot run on a database a newer one has migrated.
#
#   scripts/keycloak-restore.sh keycloak-dumps/keycloak-24.0.5-before-26.8.1-<stamp>.dump
#
# Sign-in changes made since the dump (new accounts, passwords) are lost.
#
# A script of its own, not only a step in upgrade.sh: rolling a release back swaps in that
# release's upgrade.sh, which may know nothing about Keycloak dumps. Files a release does
# not carry are left in place, so this one is still here after a rollback.
set -euo pipefail
cd "$(dirname "$0")/.."

die() { printf 'keycloak-restore: %s\n' "$*" >&2; exit 1; }
DUMP="${1:-}"
[ -n "$DUMP" ] || die "usage: scripts/keycloak-restore.sh keycloak-dumps/<file>.dump"
[ -s "$DUMP" ] || die "$DUMP is not a file here."
[ -f .env ] || die "no .env here; run this from the Depot install directory."
if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else die "Docker Compose not found."; fi
COMPOSE="-f docker-compose.yml"
MODE="$(sed -n 's/^MEMEX_MODE=//p' .env)"
[ -n "$MODE" ] || MODE="$(grep -q '^TRUST_PROXY=1' .env && echo public || echo local)"
[ "$MODE" = "public" ] && COMPOSE="$COMPOSE -f docker-compose.prod.yml"

# shellcheck disable=SC2086
$DC $COMPOSE up -d postgres </dev/null >/dev/null 2>&1 || die "Postgres didn't start. Nothing was changed."
pg_up=0
for _ in $(seq 1 40); do
  # shellcheck disable=SC2086
  if $DC $COMPOSE exec -T postgres pg_isready -U memex </dev/null >/dev/null 2>&1; then pg_up=1; break; fi
  sleep 3
done
[ "$pg_up" = "1" ] || die "Postgres isn't answering. Nothing was changed."

echo "keycloak-restore: stopping Keycloak and restoring its database from $DUMP"
# shellcheck disable=SC2086
$DC $COMPOSE stop keycloak </dev/null
# Dropped and made again, not restored over: the newer version's extra tables would
# otherwise stay behind for the older one to trip on.
# shellcheck disable=SC2086
$DC $COMPOSE exec -T postgres sh -c 'dropdb -U memex --if-exists keycloak && createdb -U memex -O memex keycloak' </dev/null \
  || die "couldn't empty the Keycloak database; Keycloak is stopped and nothing was restored."
# shellcheck disable=SC2086
$DC $COMPOSE exec -T postgres pg_restore -U memex -d keycloak --no-owner --exit-on-error < "$DUMP" \
  || die "restoring $DUMP failed; Keycloak is stopped. Run this again, or restore a full backup (scripts/restore-memex.sh)."
# shellcheck disable=SC2086
$DC $COMPOSE up -d keycloak </dev/null
echo "keycloak-restore: done; Keycloak $(grep -o 'quay.io/keycloak/keycloak:[0-9][0-9.]*' docker-compose.yml | head -1 | cut -d: -f2) is starting on the restored database."
