#!/usr/bin/env bash
#
# Memex one-command installer.
#
#   Public repo, anywhere:
#     curl -fsSL https://raw.githubusercontent.com/cdburgess75/Memex/main/install.sh | bash
#
#   Or from a clone:
#     ./install.sh
#
# It clones the repo if needed, generates strong secrets, asks a few questions,
# writes .env, then builds and starts the stack (Postgres + Keycloak + app).
#
# Non-interactive use: pre-set any of the prompted vars in the environment
# (MODE, ADMIN_EMAIL, ANTHROPIC_API_KEY, APP_DOMAIN). MEMEX_DRY_RUN=1 writes
# .env and stops before touching Docker.
set -euo pipefail

REPO_URL="${MEMEX_REPO_URL:-https://github.com/cdburgess75/Memex.git}"
BRANCH="${MEMEX_BRANCH:-main}"
TARGET_DIR="${MEMEX_DIR:-memex}"
DRY_RUN="${MEMEX_DRY_RUN:-0}"
TTY=/dev/tty

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=; G=; Y=; R=; N=; fi

# Can we actually open the terminal for prompts? (curl|bash puts the script on
# stdin, so we read from /dev/tty — but only if it's genuinely connected.)
if { : <"$TTY"; } 2>/dev/null; then HAVE_TTY=1; else HAVE_TTY=0; fi
info(){ printf '%s==>%s %s\n' "$G$B" "$N" "$*"; }
warn(){ printf '%s !%s %s\n'  "$Y$B" "$N" "$*"; }
die(){  printf '%s x%s %s\n'  "$R$B" "$N" "$*" >&2; exit 1; }

# Prompt that works even when the script itself arrives on stdin (curl | bash).
ask(){ # ask VAR "prompt" "default"
  local __var="$1" __prompt="$2" __default="${3:-}" __ans=""
  if [ -n "${!__var:-}" ]; then return; fi               # already set in env
  if [ "$HAVE_TTY" = 0 ]; then printf -v "$__var" '%s' "$__default"; return; fi
  if [ -n "$__default" ]; then printf '%s%s%s [%s]: ' "$B" "$__prompt" "$N" "$__default" >"$TTY"
  else printf '%s%s%s: ' "$B" "$__prompt" "$N" >"$TTY"; fi
  IFS= read -r __ans <"$TTY" || true
  printf -v "$__var" '%s' "${__ans:-$__default}"
}
ask_secret(){ # ask_secret VAR "prompt"
  local __var="$1" __prompt="$2" __ans=""
  if [ -n "${!__var:-}" ]; then return; fi
  if [ "$HAVE_TTY" = 0 ]; then printf -v "$__var" '%s' ""; return; fi
  printf '%s%s%s (hidden, blank to skip): ' "$B" "$__prompt" "$N" >"$TTY"
  IFS= read -rs __ans <"$TTY" || true; printf '\n' >"$TTY"
  printf -v "$__var" '%s' "$__ans"
}
gen(){ # gen NBYTES -> hex
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

# ── Preflight ────────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "Docker not found — install Docker Engine first: https://docs.docker.com/engine/install/"
if docker compose version >/dev/null 2>&1; then DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then DC="docker-compose"
else die "Docker Compose v2 not found — install the compose plugin."; fi
docker info >/dev/null 2>&1 || die "Can't reach the Docker daemon. Is it running, and are you in the docker group? (sudo usermod -aG docker \$USER, then re-login)"

# ── Get the code ─────────────────────────────────────────────────────────────
if [ -f docker-compose.yml ] && [ -f index.html ]; then
  info "Using the Memex repo in $(pwd)"
else
  command -v git >/dev/null 2>&1 || die "git not found — needed to download Memex."
  if [ -d "$TARGET_DIR/.git" ]; then
    info "Updating existing clone in ./$TARGET_DIR"; git -C "$TARGET_DIR" pull --ff-only
  else
    info "Cloning $REPO_URL → ./$TARGET_DIR"; git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$TARGET_DIR"
  fi
  cd "$TARGET_DIR"
fi

# ── Configure ────────────────────────────────────────────────────────────────
KEEP_ENV=0
if [ -f .env ]; then
  warn "A .env already exists here."
  ask REUSE "Reuse it and keep current secrets? (y/n)" "y"
  case "$REUSE" in y*|Y*) KEEP_ENV=1 ;; esac
fi

if [ "$KEEP_ENV" = "0" ]; then
  info "Let's configure this deployment."
  ask MODE "Mode — 'local' (http on this box) or 'public' (HTTPS via your domain)" "local"
  ask METHOD "App image — 'prebuilt' (pull from GHCR, fast) or 'source' (build here)" "prebuilt"
  ask ADMIN_EMAIL "Your admin email (gets the admin role on first login; blank = skip)" ""
  ask_secret ANTHROPIC_API_KEY "Anthropic API key for AI features (sk-ant-…)"
  MEMEX_TAG="${MEMEX_TAG:-latest}"
  PORT="${PORT:-3000}"           # app host port
  KC_PORT="${KC_PORT:-8080}"     # keycloak host port

  if [ "$MODE" = "public" ]; then
    ask APP_DOMAIN "Public domain (e.g. memex.acme.com)" ""
    [ -n "${APP_DOMAIN:-}" ] || die "Public mode needs a domain."
    # Behind HTTPS the editor must be told to speak wss:// — ssl.termination=true.
    APP_URL="https://$APP_DOMAIN"; KEYCLOAK_URL="auto"; TRUST_PROXY="1"; COLLABORA_SSL="true"
  else
    # Plain http on this box → the editor speaks ws:// (ssl.termination=false).
    APP_URL="http://localhost:$PORT"; KEYCLOAK_URL="http://localhost:$KC_PORT"; TRUST_PROXY=""; COLLABORA_SSL="false"
  fi

  # The seeded Keycloak user admin@memex.local is the only account that exists on
  # a fresh install, so it must stay in ADMIN_EMAILS for the first login to be admin.
  ADMIN_EMAILS="admin@memex.local"
  [ -n "${ADMIN_EMAIL:-}" ] && ADMIN_EMAILS="admin@memex.local,$ADMIN_EMAIL"

  POSTGRES_PASSWORD="$(gen 24)"
  KEYCLOAK_ADMIN_PASSWORD="$(gen 24)"
  STORAGE_ENCRYPTION_KEY="$(gen 32)"

  info "Writing .env (generated secrets — keep this file safe)"
  umask 077
  cat > .env <<EOF
# Generated by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Keep secret.
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
KEYCLOAK_ADMIN_USER=admin
KEYCLOAK_ADMIN_PASSWORD=$KEYCLOAK_ADMIN_PASSWORD
KEYCLOAK_URL=$KEYCLOAK_URL
KEYCLOAK_PUBLIC_PORT=$KC_PORT
KEYCLOAK_REALM=memex
KEYCLOAK_CLIENT_ID=memex-app
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
ANTHROPIC_MODEL=claude-sonnet-4-6
ADMIN_EMAILS=$ADMIN_EMAILS
APP_URL=$APP_URL
TRUST_PROXY=$TRUST_PROXY
STORAGE_PROVIDER=local
STORAGE_ENCRYPTION_KEY=$STORAGE_ENCRYPTION_KEY
# In-browser Office editing (Collabora) on by default. SSL termination follows
# the deployment mode: true behind HTTPS (wss), false for plain-http local (ws).
COLLABORA_ENABLED=true
COLLABORA_SSL_TERMINATION=$COLLABORA_SSL
MEMEX_TAG=$MEMEX_TAG
PORT=$PORT
EOF
else
  MODE="$(grep -q '^TRUST_PROXY=1' .env && echo public || echo local)"
  METHOD="${METHOD:-prebuilt}"
  # Existing .env from an older installer may predate in-browser editing — make
  # sure the Collabora flags are present so editing works after this run too.
  grep -q '^COLLABORA_ENABLED=' .env || printf 'COLLABORA_ENABLED=true\n' >> .env
  grep -q '^COLLABORA_SSL_TERMINATION=' .env \
    || printf 'COLLABORA_SSL_TERMINATION=%s\n' "$([ "$MODE" = public ] && echo true || echo false)" >> .env
fi
# App host port (source of truth: .env) — used by the health check and summary.
PORT="$(grep -E '^PORT=' .env | head -1 | cut -d= -f2)"; PORT="${PORT:-3000}"

# ── Launch ───────────────────────────────────────────────────────────────────
COMPOSE="-f docker-compose.yml"
[ "$MODE" = "public" ] && COMPOSE="$COMPOSE -f docker-compose.prod.yml"

if [ "$DRY_RUN" = "1" ]; then
  info "[dry-run] .env written. Method=$METHOD. Stopping before Docker."; exit 0
fi

# shellcheck disable=SC2086
if [ "$METHOD" = "source" ]; then
  info "Building and starting the stack from source — first run takes a few minutes…"
  $DC $COMPOSE up -d --build
else
  info "Pulling images (prebuilt app from GHCR) and starting…"
  if $DC $COMPOSE pull; then
    $DC $COMPOSE up -d
  else
    warn "Couldn't pull the prebuilt app image (is the GHCR package public?). Falling back to building from source…"
    $DC $COMPOSE up -d --build
  fi
fi

info "Waiting for the app to become healthy…"
ok=0
for _ in $(seq 1 60); do
  if [ "$(curl -s -m3 -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" 2>/dev/null || true)" = "200" ]; then ok=1; break; fi
  sleep 3
done

echo
if [ "$ok" = "1" ]; then info "Memex is up. 🎉"; else warn "Stack started but the app didn't answer on :$PORT yet — check '$DC $COMPOSE logs -f app'."; fi
echo
echo "  ${B}First login${N}"
echo "    Email:    admin@memex.local"
echo "    Password: memex-admin   (you'll be forced to change it)"
echo
if [ "$MODE" = "public" ]; then
  echo "  ${B}Go live on your domain${N} (${APP_URL:-https://your-domain})"
  echo "    1. DNS A record  → this server's public IP"
  echo "    2. Port-forward  → TCP 80 and 443 to this host"
  echo "    3. In Memex: Settings → System → App URL = ${APP_URL:-https://your-domain}"
  echo "    Caddy then auto-issues a Let's Encrypt cert on first visit."
else
  echo "  ${B}Open${N}  http://localhost:$PORT   (or http://<this-host-ip>:$PORT on your LAN)"
fi
echo
echo "  ${B}Included${N}"
echo "    In-browser Office editing (Collabora) is enabled."
echo "    Optional per-deployment setup (Settings → …): Workspace branding, Email (365/SMTP)."
echo
echo "  ${B}Manage${N}"
echo "    Logs:    $DC $COMPOSE logs -f app"
echo "    Stop:    $DC $COMPOSE down"
echo "    Update:  ./upgrade.sh            # or: git pull && $DC $COMPOSE up -d --build"
echo
