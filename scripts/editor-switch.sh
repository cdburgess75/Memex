#!/usr/bin/env bash
#
# Starts or stops the in-browser Office editor (the `collabora` service) so it
# matches the switch an admin sets in Depot: Settings → Branding & links → In-browser editing.
#
#   ./scripts/editor-switch.sh             apply the switch now
#   ./scripts/editor-switch.sh --install   also run it every minute from cron (Linux, root)
#
# The app is deliberately given no access to Docker, so it cannot start a container
# itself. It records the admin's choice in the database; this script, on the host,
# reads that one value and does the starting and stopping. Safe to run by hand at
# any time, and it changes nothing when the editor is already in the right state.
set -uo pipefail
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 0
[ -f .env ] && [ -f docker-compose.yml ] || { echo "editor-switch: no Depot install in $ROOT" >&2; exit 0; }

if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else echo "editor-switch: Docker Compose not found" >&2; exit 0; fi

MODE="$(sed -n 's/^MEMEX_MODE=//p' .env | head -1)"
[ -n "$MODE" ] || MODE="$(grep -q '^TRUST_PROXY=1' .env && echo public || echo local)"
COMPOSE="-f docker-compose.yml"; [ "$MODE" = "public" ] && COMPOSE="$COMPOSE -f docker-compose.prod.yml"

CRON_FILE=/etc/cron.d/depot-editor-switch
if [ "${1:-}" = "--install" ]; then
  if [ "$(uname -s)" = "Linux" ] && [ "$(id -u)" = "0" ] && [ -d /etc/cron.d ]; then
    printf '# Depot: start/stop the in-browser editor to match the switch in Settings.\n* * * * * root %s/scripts/editor-switch.sh >/dev/null 2>&1\n' "$ROOT" > "$CRON_FILE"
    chmod 644 "$CRON_FILE"
    echo "editor-switch: installed $CRON_FILE (runs every minute)"
  else
    echo "editor-switch: not scheduling (needs Linux, root and /etc/cron.d). After changing the"
    echo "               switch in Settings, run $ROOT/scripts/editor-switch.sh to apply it."
  fi
fi

# One run at a time: a first start can spend minutes downloading the editor image.
if command -v flock >/dev/null 2>&1; then
  exec 9>"${TMPDIR:-/tmp}/depot-editor-switch.lock"
  flock -n 9 || exit 0
fi

# stdin from /dev/null throughout: this may be reached from `curl … | bash` installs,
# where a command that reads stdin would swallow the rest of the calling script.
# shellcheck disable=SC2086
WANT="$($DC $COMPOSE exec -T postgres psql -U memex -d memex -tA -c \
  "SELECT value FROM system_settings WHERE key = 'collabora_enabled'" </dev/null 2>/dev/null)" \
  || exit 0   # database not answering: leave the editor exactly as it is
WANT="$(printf '%s' "$WANT" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"

# shellcheck disable=SC2086
RUNNING="$($DC $COMPOSE --profile editor ps -q --status running collabora </dev/null 2>/dev/null || true)"

if [ "$WANT" = "true" ]; then
  [ -n "$RUNNING" ] || echo "editor-switch: editing is switched on - starting the editor"
  # Run `up` whether or not it is already running: a release that changed the editor's
  # definition is applied this way (it does nothing when nothing changed).
  # --no-deps: never touch the app or database containers from here.
  # shellcheck disable=SC2086
  $DC $COMPOSE --profile editor up -d --no-deps collabora </dev/null >/dev/null
elif [ -n "$RUNNING" ]; then
  echo "editor-switch: editing is switched off - stopping the editor"
  # shellcheck disable=SC2086
  $DC $COMPOSE --profile editor stop collabora </dev/null
fi
exit 0
