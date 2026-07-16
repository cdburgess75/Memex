#!/usr/bin/env bash
#
# Non-destructive disaster-recovery drill. Dumps the memex + keycloak databases,
# restores each into a THROWAWAY copy, checks the restored row counts match live for
# key tables, then drops the copies. Proves a restore actually recovers your data
# (including Keycloak accounts) without touching production.
#
# Run periodically and keep the output as your "backup restore test" evidence.
#
#   ./restore-drill.sh
#
set -euo pipefail
ROOT_DIR="${MEMEX_ROOT:-/opt/memex}"
cd "$ROOT_DIR"

if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else echo "Docker Compose not found." >&2; exit 2; fi
COMPOSE="-f docker-compose.yml"
grep -q '^TRUST_PROXY=1' .env 2>/dev/null && COMPOSE="$COMPOSE -f docker-compose.prod.yml"

echo "Restore drill (non-destructive) — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
# shellcheck disable=SC2086
$DC $COMPOSE exec -T postgres sh <<'INNER'
export PGUSER=memex
fail=0
run_db() {
  db="$1"; shift; drill="${db}_drill"
  pg_dump -d "$db" -Fc -f "/tmp/${db}.dump" || { echo "  FAIL  $db: dump failed"; return 0; }
  dropdb --if-exists "$drill" >/dev/null 2>&1 || true
  createdb "$drill" || { echo "  FAIL  $db: createdb failed"; return 0; }
  pg_restore --no-owner -d "$drill" "/tmp/${db}.dump" >/dev/null 2>&1 || true
  for t in "$@"; do
    live=$(psql -d "$db" -tA -c "SELECT count(*) FROM $t" 2>/dev/null || echo "?")
    rest=$(psql -d "$drill" -tA -c "SELECT count(*) FROM $t" 2>/dev/null || echo "?")
    if [ "$live" = "$rest" ] && [ "$live" != "?" ]; then echo "  PASS  $db.$t: $rest rows restored (matches live)"
    else echo "  FAIL  $db.$t: live=$live restored=$rest"; fail=1; fi
  done
  dropdb --if-exists "$drill" >/dev/null 2>&1 || true
  rm -f "/tmp/${db}.dump"
}
run_db memex documents user_roles
run_db keycloak user_entity
if [ "$fail" = "0" ]; then echo "RESULT: PASS — a restore recovers both databases (incl. Keycloak accounts)."
else echo "RESULT: FAIL — investigate before relying on backups."; exit 1; fi
INNER
