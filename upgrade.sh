#!/usr/bin/env bash
#
# Upgrade Memex to a published image tag (no source build).
#
#   ./upgrade.sh            # pull and deploy :latest
#   ./upgrade.sh v2026.06.22.001   # pin to a specific release
#
# Run it from the Memex directory (where docker-compose.yml and .env live).
set -euo pipefail
cd "$(dirname "$0")"

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=; G=; Y=; R=; N=; fi
info(){ printf '%s==>%s %s\n' "$G$B" "$N" "$*"; }
warn(){ printf '%s !%s %s\n'  "$Y$B" "$N" "$*"; }
die(){  printf '%s x%s %s\n'  "$R$B" "$N" "$*" >&2; exit 1; }

[ -f .env ] || die "No .env here. Run this from your Memex install directory."
if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else die "Docker Compose not found."; fi

TAG="${1:-latest}"
COMPOSE="-f docker-compose.yml"
# Prefer the explicit MEMEX_MODE marker (install.sh writes it); fall back to the
# TRUST_PROXY heuristic for .env files from older installers.
MODE="$(sed -n 's/^MEMEX_MODE=//p' .env)"
[ -n "$MODE" ] || MODE="$(grep -q '^TRUST_PROXY=1' .env && echo public || echo local)"
[ "$MODE" = "public" ] && COMPOSE="$COMPOSE -f docker-compose.prod.yml"

# Pin the tag in .env (add or replace MEMEX_TAG=…).
if grep -q '^MEMEX_TAG=' .env; then
  sed -i.bak "s|^MEMEX_TAG=.*|MEMEX_TAG=$TAG|" .env && rm -f .env.bak
else
  printf 'MEMEX_TAG=%s\n' "$TAG" >> .env
fi

IMAGE="ghcr.io/cdburgess75/memex:$TAG"
info "Upgrading app to $IMAGE"
# MEMEX_SKIP_PULL=1 deploys an image that is already on this machine (one built here
# from source, say) instead of fetching the tag from the registry.
if [ "${MEMEX_SKIP_PULL:-0}" != "1" ]; then
  # shellcheck disable=SC2086
  $DC $COMPOSE pull app || die "Pull failed — is the tag published and the GHCR package public?"
fi

# ── Refresh the host files from the release being deployed ───────────────────
# The compose files and the scripts beside them were written once, at install, and
# an image pull never touched them — so a release that changed how the stack is run
# only half-arrived. Every image carries the repo, so copy this release's versions
# out of it before starting anything. Each file is swapped in with a rename, which
# is what makes it safe for this script to replace itself while it is running.
# Left alone on purpose: .env (this server's secrets and settings), the Caddyfile
# and the Keycloak realm file (mounted into running containers), and install.sh.
# The files being replaced are kept in .host-previous/ in case one was hand-edited.
refresh_host_files() {
  local cid tmp f
  cid="$(docker create "$IMAGE" 2>/dev/null)" || { warn "Couldn't read host files out of $IMAGE — keeping the ones here."; return 0; }
  tmp="$(mktemp -d)"
  if docker cp "$cid:/app/scripts/editor-switch.sh" "$tmp/probe" >/dev/null 2>&1; then
    mkdir -p .host-previous scripts
    for f in docker-compose.yml docker-compose.prod.yml upgrade.sh; do
      docker cp "$cid:/app/$f" "$tmp/$f" >/dev/null 2>&1 || continue
      if ! cmp -s "$tmp/$f" "$f"; then
        [ -f "$f" ] && cp -p "$f" ".host-previous/$f"
        cp -p "$tmp/$f" "$f.new" && mv -f "$f.new" "$f" && info "Updated $f"
      fi
    done
    if docker cp "$cid:/app/scripts" "$tmp/scripts" >/dev/null 2>&1; then
      for f in "$tmp"/scripts/*.sh "$tmp"/scripts/*.js; do
        [ -f "$f" ] || continue
        local name; name="scripts/$(basename "$f")"
        cmp -s "$f" "$name" && continue
        mkdir -p .host-previous/scripts
        [ -f "$name" ] && cp -p "$name" ".host-previous/$name"
        cp -p "$f" "$name.new" && mv -f "$name.new" "$name" && info "Updated $name"
      done
    fi
    chmod +x upgrade.sh scripts/editor-switch.sh 2>/dev/null || true
  else
    # A release from before host files travelled with the image (a rollback, say).
    info "This release carries no host files — keeping the ones here."
  fi
  docker rm "$cid" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
refresh_host_files

# ── Keycloak going backwards ─────────────────────────────────────────────────
# A newer Keycloak migrates its database on first start (the keycloak-predump service
# in docker-compose.yml dumps it first, into keycloak-dumps/), and an older Keycloak
# cannot run on a database a newer one has migrated. So when the release being
# deployed carries an older Keycloak than the one that last wrote the database (a
# rollback), there are two ways through:
#   KC_RESTORE_DUMP=keycloak-dumps/<file> ./upgrade.sh <tag>
#       puts the database back as the dump has it, then starts the older Keycloak.
#       Sign-in changes made since the dump (new accounts, passwords) are lost.
#   ./upgrade.sh <tag>   (no KC_RESTORE_DUMP)
#       rolls back everything else and leaves the newer Keycloak running as it is.
KC_TARGET="$(grep -o 'quay.io/keycloak/keycloak:[0-9][0-9.]*' docker-compose.yml | head -1 | cut -d: -f2)"
# shellcheck disable=SC2086
KC_DB_VERSION="$($DC $COMPOSE exec -T postgres psql -U memex -d keycloak -XAtc \
  "SELECT version FROM migration_model ORDER BY update_time DESC, version DESC LIMIT 1" </dev/null 2>/dev/null | tr -d '\r' || true)"
kc_older() { # is $1 an older version than $2?
  awk -v a="$1" -v b="$2" 'BEGIN { n = split(a, x, "."); m = split(b, y, "."); if (m > n) n = m
    for (i = 1; i <= n; i++) { if (x[i] + 0 != y[i] + 0) exit !(x[i] + 0 < y[i] + 0) } exit 1 }'
}
UP_ARGS=""
if [ -n "$KC_TARGET" ] && [ -n "$KC_DB_VERSION" ] && kc_older "$KC_TARGET" "$KC_DB_VERSION"; then
  if [ -n "${KC_RESTORE_DUMP:-}" ]; then
    [ -s "$KC_RESTORE_DUMP" ] || die "KC_RESTORE_DUMP=$KC_RESTORE_DUMP is not a file here."
    info "Restoring the Keycloak database from $KC_RESTORE_DUMP for Keycloak $KC_TARGET (it was at $KC_DB_VERSION)"
    # shellcheck disable=SC2086
    $DC $COMPOSE stop keycloak </dev/null
    # Dropped and made again, not restored over: the newer version's extra tables
    # would otherwise stay behind for the older one to trip on.
    # shellcheck disable=SC2086
    $DC $COMPOSE exec -T postgres sh -c 'dropdb -U memex --if-exists keycloak && createdb -U memex -O memex keycloak' </dev/null \
      || die "Couldn't empty the Keycloak database; Keycloak is stopped. Nothing was restored."
    # shellcheck disable=SC2086
    $DC $COMPOSE exec -T postgres pg_restore -U memex -d keycloak --no-owner --exit-on-error < "$KC_RESTORE_DUMP" \
      || die "Restoring $KC_RESTORE_DUMP failed; Keycloak is stopped. Run the same command again, or restore a full backup (scripts/restore-memex.sh)."
    info "Keycloak database restored."
  else
    warn "This release runs Keycloak $KC_TARGET, but Keycloak $KC_DB_VERSION already migrated its database."
    warn "Keycloak stays on $KC_DB_VERSION; everything else rolls back. To take Keycloak back too:"
    warn "  KC_RESTORE_DUMP=keycloak-dumps/<the dump from that upgrade> ./upgrade.sh $TAG"
    # The editor is left out too: editor-switch.sh below starts it or not, and naming a
    # service would start it even with its profile off (some Compose versions list it).
    # shellcheck disable=SC2086
    UP_ARGS="--no-deps $($DC $COMPOSE config --services </dev/null | grep -vx -e keycloak -e keycloak-predump -e collabora | tr '\n' ' ')"
  fi
fi

# Bring the whole stack in line with the compose file, not only the app: a release
# can change how another service runs (a memory limit, say). Containers whose
# definition did not change are left running. The in-browser editor sits behind a
# profile and is not started here; editor-switch.sh below starts or stops it to
# match the switch in Settings.
# shellcheck disable=SC2086
$DC $COMPOSE up -d $UP_ARGS
# What keycloak-predump did this time (a dump taken, or nothing to do) — said here so
# the path of a fresh dump is on screen with the rest of the update.
# shellcheck disable=SC2086
$DC $COMPOSE logs --no-log-prefix keycloak-predump </dev/null 2>/dev/null | tail -3 | sed 's/^/    /' || true

# App host port (source of truth: .env) — the health probe honors a non-default PORT.
PORT="$(grep -E '^PORT=' .env | head -1 | cut -d= -f2)"; PORT="${PORT:-3000}"

info "Waiting for the app to become healthy…"
ok=0
for _ in $(seq 1 40); do
  # /healthz pings the database, so a 200 means a real boot (not just the SPA shell).
  if [ "$(curl -s -m3 -o /dev/null -w '%{http_code}' "http://localhost:$PORT/healthz" 2>/dev/null || true)" = "200" ]; then ok=1; break; fi
  sleep 3
done
if [ "$ok" = "1" ]; then info "Upgrade complete — now running :$TAG. 🎉"
else warn "App didn't answer on :$PORT yet — check '$DC $COMPOSE logs -f app'."; fi

# Keycloak is recreated when its definition changed (a memory limit, say); nobody can
# sign in until it answers, so wait for it too before calling the update done.
KC_PORT="$(grep -E '^KEYCLOAK_PUBLIC_PORT=' .env | head -1 | cut -d= -f2)"; KC_PORT="${KC_PORT:-8080}"
kc_ok=0
for _ in $(seq 1 40); do
  if [ "$(curl -s -m3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$KC_PORT/realms/memex/.well-known/openid-configuration" 2>/dev/null || true)" = "200" ]; then kc_ok=1; break; fi
  sleep 3
done
[ "$kc_ok" = "1" ] || warn "Keycloak isn't answering on :$KC_PORT yet — sign-in may take a little longer; check '$DC $COMPOSE logs -f keycloak'."

# Every release leaves the previous Depot image behind, and they add up (124 of them,
# 42 GB, had filled one server's disk). Once the new release is healthy, remove the Depot
# images no container uses. Only images carrying Depot's own label: Postgres, Keycloak,
# Caddy and the editor are never touched. Rolling back downloads the older image again.
if [ "$ok" = "1" ]; then
  docker image prune -a -f --filter "label=org.opencontainers.image.source=https://github.com/cdburgess75/Memex" </dev/null >/dev/null 2>&1 \
    && info "Removed older Depot images." || true
fi

# Keep the editor's on/off helper scheduled, and apply the switch once now.
[ -x scripts/editor-switch.sh ] && { ./scripts/editor-switch.sh --install </dev/null || true; }
exit 0
