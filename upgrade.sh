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
grep -q '^TRUST_PROXY=1' .env && COMPOSE="$COMPOSE -f docker-compose.prod.yml"

# Pin the tag in .env (add or replace MEMEX_TAG=…).
if grep -q '^MEMEX_TAG=' .env; then
  sed -i.bak "s|^MEMEX_TAG=.*|MEMEX_TAG=$TAG|" .env && rm -f .env.bak
else
  printf 'MEMEX_TAG=%s\n' "$TAG" >> .env
fi

info "Upgrading app to ghcr.io/cdburgess75/memex:$TAG"
# shellcheck disable=SC2086
$DC $COMPOSE pull app || die "Pull failed — is the tag published and the GHCR package public?"
# shellcheck disable=SC2086
$DC $COMPOSE up -d app

info "Waiting for the app to become healthy…"
ok=0
for _ in $(seq 1 40); do
  if [ "$(curl -s -m3 -o /dev/null -w '%{http_code}' http://localhost:3000/ 2>/dev/null || true)" = "200" ]; then ok=1; break; fi
  sleep 3
done
if [ "$ok" = "1" ]; then info "Upgrade complete — now running :$TAG. 🎉"
else warn "App didn't answer on :3000 yet — check '$DC $COMPOSE logs -f app'."; fi
