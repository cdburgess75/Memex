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

# Bring the whole stack in line with the compose file, not only the app: a release
# can change how another service runs (a memory limit, say). Containers whose
# definition did not change are left running. The in-browser editor sits behind a
# profile and is not started here; editor-switch.sh below starts or stops it to
# match the switch in Settings.
# shellcheck disable=SC2086
$DC $COMPOSE up -d

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

# Keep the editor's on/off helper scheduled, and apply the switch once now.
[ -x scripts/editor-switch.sh ] && { ./scripts/editor-switch.sh --install </dev/null || true; }
exit 0
