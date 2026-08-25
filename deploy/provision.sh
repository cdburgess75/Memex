#!/usr/bin/env bash
#
# ParaTech fleet bootstrap: blank Ubuntu VM → fully provisioned customer Depot.
#
#   sudo ./provision.sh /root/<slug>.answers.env
#
# The answers file (see answers.example.env) carries everything site-specific;
# this script is deliberately generic and safe to re-run — every stage checks
# before it changes anything, so a failed run is resumed by running it again.
#
# What it does, in order: preflight (specs + DNS) → base packages → Docker →
# Tailscale (management overlay) → ufw → RMM agent → Depot install (public mode,
# pinned tag) → license + backup-escrow secrets → app_url + backup settings →
# real admin identities (seed admin disabled) → forced first TLS issuance →
# verified backup run → monitoring drop-in → verification gate.
#
# Site prerequisites (SITE-REQUIREMENTS.md): static public IP, TCP 80/443
# forwarded to this VM, one DNS A record for the domain, Ubuntu 26.04 LTS.
set -euo pipefail

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=; G=; Y=; R=; N=; fi
info(){ printf '%s==>%s %s\n' "$G$B" "$N" "$*"; }
warn(){ printf '%s !%s %s\n'  "$Y$B" "$N" "$*"; }
die(){  printf '%s x%s %s\n'  "$R$B" "$N" "$*" >&2; exit 1; }

# ── Stage 0: guards ──────────────────────────────────────────────────────────
[ "$(id -u)" = "0" ] || die "Run as root (sudo)."
ANSWERS="${1:-}"
[ -n "$ANSWERS" ] && [ -f "$ANSWERS" ] || die "Usage: provision.sh <answers.env> (see deploy/answers.example.env)"
# shellcheck disable=SC1090
. "$ANSWERS"

for v in CUSTOMER_SLUG APP_DOMAIN STATIC_IP CUSTOMER_ADMIN_EMAIL PARATECH_EMAIL MEMEX_TAG LICENSE_JSON_B64 MEMEX_BACKUP_KEY_PASSPHRASE; do
  [ -n "${!v:-}" ] || die "Answers file is missing $v"
done
[ "$MEMEX_TAG" != "latest" ] || die "MEMEX_TAG must be a pinned release tag, never 'latest', on a fleet box."
TS_HOSTNAME="${TS_HOSTNAME:-depot-$CUSTOMER_SLUG}"
BACKUP_INTERVAL_HOURS="${BACKUP_INTERVAL_HOURS:-24}"
BACKUP_RETENTION="${BACKUP_RETENTION:-7}"
MEMEX_ROOT="${MEMEX_ROOT:-/opt/memex}"
PARA_DIR="$MEMEX_ROOT/.paratech"

. /etc/os-release 2>/dev/null || true
case "${VERSION_ID:-}" in
  26.04) : ;;
  *) warn "Expected Ubuntu 26.04 LTS, found ${PRETTY_NAME:-unknown} — continuing, but the fleet standard is 26.04." ;;
esac

# ── Stage 1: preflight (fail before changing anything) ───────────────────────
info "Preflight: specs and DNS"
MEM_GB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
[ "$MEM_GB" -ge 7 ] || die "VM has ${MEM_GB}GB RAM; the minimum is 8GB."
DISK_GB=$(( $(df -P --block-size=1G / | awk 'NR==2 {print $4}') ))
[ "$DISK_GB" -ge 80 ] || die "Only ${DISK_GB}GB free on /; the minimum is 100GB provisioned."

command -v dig >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq dnsutils >/dev/null; }
RESOLVED="$(dig +short A "$APP_DOMAIN" @1.1.1.1 | tail -1)"
[ "$RESOLVED" = "$STATIC_IP" ] || die "DNS says $APP_DOMAIN → ${RESOLVED:-nothing}; expected the static IP $STATIC_IP. Fix the A record first (TTL 300 recommended)."
EGRESS="$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
[ "$EGRESS" = "$STATIC_IP" ] || warn "Egress IP is ${EGRESS:-unknown}, not $STATIC_IP — double-check the site's WAN before go-live."

# ── Stage 2: base packages ───────────────────────────────────────────────────
info "Base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git jq dnsutils ufw >/dev/null

# ── Stage 3: Docker Engine (official apt repo — deterministic) ───────────────
if docker info >/dev/null 2>&1; then
  info "Docker already running — skipping install"
else
  info "Installing Docker Engine"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-${VERSION_CODENAME:-noble}} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
  systemctl enable --now docker
fi

# ── Stage 4: Tailscale (management overlay; all day-2 access rides this) ─────
if command -v tailscale >/dev/null 2>&1 && [ "$(tailscale status --json 2>/dev/null | jq -r '.BackendState' 2>/dev/null)" = "Running" ]; then
  info "Tailscale already up ($(tailscale status --json | jq -r '.Self.DNSName' 2>/dev/null))"
else
  [ -n "${TS_AUTHKEY:-}" ] || die "Tailscale is not connected and the answers file has no TS_AUTHKEY (mint a short-lived, tagged key: tag:depot)."
  info "Installing + joining Tailscale as $TS_HOSTNAME"
  command -v tailscale >/dev/null 2>&1 || { curl -fsSL https://tailscale.com/install.sh | sh; }
  tailscale up --authkey="$TS_AUTHKEY" --hostname="$TS_HOSTNAME" --ssh
fi

# ── Stage 5: firewall (80/443 public; management only via the tailnet) ───────
info "Firewall baseline (ufw)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow in on tailscale0 >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

# ── Stage 6: RMM agent (site-parameterized) ──────────────────────────────────
if [ -n "${RMM_INSTALL_CMD:-}" ]; then
  if [ -n "${RMM_DETECT_CMD:-}" ] && eval "$RMM_DETECT_CMD" >/dev/null 2>&1; then
    info "RMM agent already present — skipping install"
  else
    info "Installing RMM agent"
    eval "$RMM_INSTALL_CMD"
  fi
fi

# ── Stage 7: Depot install (public mode, pinned tag) ─────────────────────────
# setsid detaches /dev/tty so install.sh never prompts — every answer is preset.
# Re-runs are safe: install.sh reuses an existing clone and .env (REUSE=y default).
info "Installing Depot $MEMEX_TAG for $APP_DOMAIN"
mkdir -p /srv/memex-documents
if [ -f "$MEMEX_ROOT/docker-compose.yml" ]; then
  # Re-run: use the existing checkout in place. (Running install.sh from inside
  # the repo skips its git path entirely — a tag checkout is detached, so its
  # `git pull --ff-only` would otherwise fail the re-run.)
  cd "$MEMEX_ROOT"
  INSTALL_SH=./install.sh
else
  # First run: fetch the installer from the release being deployed; it clones
  # the tag into $MEMEX_ROOT itself.
  curl -fsSL "https://raw.githubusercontent.com/${MEMEX_REPO:-cdburgess75/Memex}/${MEMEX_TAG}/install.sh" -o /tmp/depot-install.sh
  INSTALL_SH=/tmp/depot-install.sh
fi
setsid --wait env \
  MODE=public METHOD=prebuilt \
  APP_DOMAIN="$APP_DOMAIN" \
  ADMIN_EMAIL="$CUSTOMER_ADMIN_EMAIL" \
  ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
  MEMEX_TAG="$MEMEX_TAG" \
  MEMEX_DIR="$MEMEX_ROOT" \
  MEMEX_BRANCH="$MEMEX_TAG" \
  bash "$INSTALL_SH" < /dev/null

cd "$MEMEX_ROOT"
COMPOSE="-f docker-compose.yml -f docker-compose.prod.yml"
# The docs bind-mount is root-owned on a fresh host; the container runs as `memex`.
# shellcheck disable=SC2086
docker compose $COMPOSE run --rm --no-deps -u root app chown memex:memex /data/documents 2>/dev/null || true

# ── Stage 8: license + fleet env ─────────────────────────────────────────────
info "Dropping license + fleet environment"
install -d -m 700 "$MEMEX_ROOT/secrets" "$PARA_DIR"
umask 077
printf '%s' "$LICENSE_JSON_B64" | base64 -d > "$MEMEX_ROOT/secrets/license.json"
jq -e .signature "$MEMEX_ROOT/secrets/license.json" >/dev/null || die "Decoded license.json is not a signed license."
envset() { # envset KEY VALUE — add or replace in .env
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
envset MEMEX_SECRETS_DIR "$MEMEX_ROOT/secrets"
envset MEMEX_BACKUP_KEY_PASSPHRASE "$MEMEX_BACKUP_KEY_PASSPHRASE"
# The app-role emails: the customer admin + the ParaTech ops account. The seeded
# admin@memex.local is disabled in stage 10, so it comes OFF the admin list here.
envset ADMIN_EMAILS "$CUSTOMER_ADMIN_EMAIL,$PARATECH_EMAIL"

# ── Stage 9: settings the app reads from the DB ──────────────────────────────
# ROPC is disabled (deliberately), so there is no scriptable admin JWT; settings
# are seeded straight into system_settings. Anyone who can run this already owns
# the box, so this is not a privilege bypass.
info "Seeding app_url + backup schedule"
seed() { # seed KEY VALUE
  # shellcheck disable=SC2086
  docker compose $COMPOSE exec -T postgres psql -U memex -d memex -q -c \
    "INSERT INTO system_settings (key, value) VALUES ('$1', '$2')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();"
}
seed app_url "https://$APP_DOMAIN"
seed backup_enabled true
seed backup_interval_hours "$BACKUP_INTERVAL_HOURS"
seed backup_retention "$BACKUP_RETENTION"

# One recreate applies the .env changes and clears the settings cache.
# shellcheck disable=SC2086
docker compose $COMPOSE up -d app >/dev/null 2>&1
info "Waiting for the app"
for _ in $(seq 1 40); do
  [ "$(curl -s -m3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/healthz || true)" = "200" ] && break
  sleep 3
done

# ── Stage 10: identity — real admins in, universal seed admin out ────────────
info "Creating admin identities in Keycloak"
set -a; . ./.env; set +a
kc() { # kcadm inside the keycloak container
  # shellcheck disable=SC2086
  docker compose $COMPOSE exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@"
}
for _ in $(seq 1 20); do
  kc config credentials --server http://localhost:8080 --realm master \
     --user "${KEYCLOAK_ADMIN_USER:-admin}" --password "$KEYCLOAK_ADMIN_PASSWORD" >/dev/null 2>&1 && break
  sleep 3
done
kc_user_id() { kc get users -r memex -q "email=$1" --fields id --format csv --noquotes 2>/dev/null | tr -d '\r' | awk -F, 'NF {print $1; exit}'; }
ensure_user() { # ensure_user EMAIL LABEL → prints "email temp-password" when created
  local id pw
  id="$(kc_user_id "$1")"
  if [ -z "$id" ]; then
    kc create users -r memex -s "username=$1" -s "email=$1" -s enabled=true \
       -s emailVerified=true -s 'requiredActions=["UPDATE_PASSWORD"]' >/dev/null
    id="$(kc_user_id "$1")"
    pw="$(openssl rand -hex 12)"
    kc set-password -r memex --userid "$id" --new-password "$pw" --temporary >/dev/null
    printf '%s\n' "  $2: $1  temp password: $pw  (forced change on first login)"
  else
    printf '%s\n' "  $2: $1 already exists — untouched"
  fi
}
echo "${B}Handoff credentials — record these now; they are not stored anywhere:${N}"
ensure_user "$CUSTOMER_ADMIN_EMAIL" "customer admin"
ensure_user "$PARATECH_EMAIL" "ParaTech ops"
SEED_ID="$(kc_user_id admin@memex.local)"
if [ -n "$SEED_ID" ]; then
  kc set-password -r memex --userid "$SEED_ID" --new-password "$(openssl rand -hex 24)" >/dev/null
  kc update "users/$SEED_ID" -r memex -s enabled=false >/dev/null
  info "Seed account admin@memex.local rotated and disabled (break-glass: re-enable via kcadm over the tailnet)."
fi

# ── Stage 11: forced first TLS issuance ──────────────────────────────────────
# Success here proves the whole public path at once: DNS, the router's 80/443
# forward (ACME HTTP-01 needs inbound 80), and the on-demand TLS gate reading
# app_url. Retries stay modest to respect Let's Encrypt failure rate limits.
info "Forcing first certificate issuance for $APP_DOMAIN"
CERT_OK=0
for i in $(seq 1 6); do
  if curl -fsS --resolve "$APP_DOMAIN:443:127.0.0.1" --max-time 90 "https://$APP_DOMAIN/healthz" >/dev/null 2>&1; then CERT_OK=1; break; fi
  warn "Issuance attempt $i failed — retrying in 20s (checking the 80/443 port-forward is the usual fix)"
  sleep 20
done
[ "$CERT_OK" = "1" ] || die "No certificate after 6 attempts. Verify the router forwards TCP 80 AND 443 to this VM, then re-run — every earlier stage skips itself."

# ── Stage 12: first backup, verified ─────────────────────────────────────────
info "Running the first backup"
# shellcheck disable=SC2086
docker compose $COMPOSE exec -T app node -e '
  require("./server/lib/backup").runBackup({ manual: true })
    .then(r => { console.log(JSON.stringify({ ok: r.ok, file: r.file || r.name || null })); process.exit(r.ok === false ? 1 : 0); })
    .catch(e => { console.error(e.message); process.exit(1); })
' || die "First backup failed — fix before handoff (backups are the restore story inside every Axcient image)."

# ── Stage 13: monitoring drop-in ─────────────────────────────────────────────
info "Installing depot-check for the RMM"
install -m 755 "$MEMEX_ROOT/scripts/depot-check.sh" /usr/local/bin/depot-check
printf '%s\n' "$MEMEX_TAG" > "$PARA_DIR/expected-tag"
{
  printf 'CUSTOMER_SLUG=%s\n' "$CUSTOMER_SLUG"
  printf 'APP_DOMAIN=%s\n' "$APP_DOMAIN"
  printf 'STATIC_IP=%s\n' "$STATIC_IP"
} > "$PARA_DIR/site.env"

# ── Stage 14: verification gate ──────────────────────────────────────────────
info "Verification gate"
FAIL=0
check() { # check LABEL CMD...
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then printf '  %s✓%s %s\n' "$G" "$N" "$label"
  else printf '  %s✗%s %s\n' "$R" "$N" "$label"; FAIL=1; fi
}
hz() { curl -fsS -m5 "$1" | jq -e "$2" >/dev/null; }
check "local healthz db up, version $MEMEX_TAG" hz "http://127.0.0.1:3000/healthz" ".db==\"up\" and .version==\"$MEMEX_TAG\""
check "public HTTPS healthz (valid cert)" curl -fsS -m10 --resolve "$APP_DOMAIN:443:127.0.0.1" "https://$APP_DOMAIN/healthz"
check "OIDC discovery via Caddy (login path)" curl -fsS -m10 --resolve "$APP_DOMAIN:443:127.0.0.1" "https://$APP_DOMAIN/realms/memex/.well-known/openid-configuration"
check "/api/config sane" hz "http://127.0.0.1:3000/api/config" '.keycloakRealm=="memex"'
check "license valid" bash -c "docker compose $COMPOSE exec -T app node -e 'require(\"./server/lib/license\").status().then(s=>process.exit(s.valid?0:1))'"
# sshd on 22 stays as the console fallback — ufw already denies it from the WAN.
check "only 80/443 (+ssh) listening publicly" bash -c "! ss -tlnp | awk '{print \$4}' | grep -E '^(0\\.0\\.0\\.0|\\[::\\]|\\*):' | grep -vE ':(22|80|443)$'"
check "tailscale online" bash -c "tailscale status --json | jq -e '.Self.Online==true'"
check "depot-check exits 0" /usr/local/bin/depot-check

umask 022
jq -n --arg slug "$CUSTOMER_SLUG" --arg domain "$APP_DOMAIN" --arg tag "$MEMEX_TAG" \
      --arg when "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg gate "$([ "$FAIL" = 0 ] && echo pass || echo fail)" \
      '{customer:$slug, domain:$domain, tag:$tag, provisioned_at:$when, gate:$gate}' > "$PARA_DIR/provisioned.json"

echo
if [ "$FAIL" = 0 ]; then
  info "Provisioned. Next: handoff meeting — customer admin signs in at https://$APP_DOMAIN, changes the temp password, and the Setup Wizard covers branding, M365/email, MFA, and limits."
else
  die "Verification gate failed — fix the ✗ items and re-run (all completed stages skip themselves)."
fi
