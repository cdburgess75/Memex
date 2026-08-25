#!/usr/bin/env bash
# Fleet health check for a deployed Depot/Memex box. Designed to be run by an RMM
# (or cron) every 5–15 minutes as root, on the install host.
#
#   Exit 0 = OK, 1 = WARN, 2 = CRIT (worst finding wins) — Nagios-compatible.
#   Output is exactly one status line:
#     DEPOT OK healthz=ok backup_age_h=11 backup=ok disk_root=41% disk_docs=37% \
#       cert_days=62 version=v2026.08.20.001 expected=match wan_ip=match ts=online
#   When not OK, a reasons=… field names every failing check.
#
# Reads (all optional — absent inputs degrade to skipped checks, never crashes):
#   $MEMEX_ROOT/.env                      install config (PORT, MEMEX_MODE, APP_URL)
#   $MEMEX_ROOT/.paratech/expected-tag    tag the fleet last deployed here
#   $MEMEX_ROOT/.paratech/site.env        STATIC_IP=… APP_DOMAIN=… CUSTOMER_SLUG=…
#
# Every network call is capped at 5s; whole run stays under ~10s.
set -uo pipefail

MEMEX_ROOT="${MEMEX_ROOT:-/opt/memex}"
ENV_FILE="$MEMEX_ROOT/.env"
PARA_DIR="$MEMEX_ROOT/.paratech"

STATUS=0            # worst severity so far
FIELDS=()           # key=value pairs for the status line
REASONS=()          # names of failing checks

bump() { [ "$1" -gt "$STATUS" ] && STATUS=$1; }
field() { FIELDS+=("$1"); }
flag() { # flag <severity 1|2> <reason> <field=value>
  bump "$1"; REASONS+=("$2"); field "$3"
}

envget() { sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | head -1; }

PORT="$(envget PORT)"; PORT="${PORT:-3000}"
MODE="$(envget MEMEX_MODE)"
[ -n "$MODE" ] || MODE="$(grep -q '^TRUST_PROXY=1' "$ENV_FILE" 2>/dev/null && echo public || echo local)"
APP_URL="$(envget APP_URL)"
COMPOSE="-f docker-compose.yml"; [ "$MODE" = "public" ] && COMPOSE="$COMPOSE -f docker-compose.prod.yml"
[ -f "$PARA_DIR/site.env" ] && . "$PARA_DIR/site.env"

have() { command -v "$1" >/dev/null 2>&1; }
if ! have jq; then echo "DEPOT WARN reasons=jq_missing (apt-get install -y jq)"; exit 1; fi

# ---- 1. healthz (also the source of the running version) ----------------------
HEALTH_JSON="$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)"
VERSION="$(jq -r '.version // empty' <<<"$HEALTH_JSON" 2>/dev/null || true)"
DB="$(jq -r '.db // empty' <<<"$HEALTH_JSON" 2>/dev/null || true)"
if [ -z "$HEALTH_JSON" ] || [ "$DB" != "up" ]; then
  flag 2 healthz "healthz=${DB:-down}"
else
  field "healthz=ok"
fi

# ---- 2. backup freshness + status (in-app engine, local staging) --------------
BK_RAW="$(cd "$MEMEX_ROOT" 2>/dev/null && timeout 8 docker compose $COMPOSE exec -T postgres \
  psql -U memex -d memex -tA -F'|' -c \
  "SELECT key, value FROM system_settings WHERE key IN ('backup_enabled','backup_interval_hours','backup_last_run','backup_last_status')" 2>/dev/null || true)"
bk() { printf '%s\n' "$BK_RAW" | sed -n "s/^$1|//p" | head -1; }
BK_ENABLED="$(bk backup_enabled)"
BK_INTERVAL="$(bk backup_interval_hours)"; BK_INTERVAL="${BK_INTERVAL:-24}"
BK_LAST="$(bk backup_last_run)"
BK_STATUS_OK="$(bk backup_last_status | jq -r '.ok // empty' 2>/dev/null || true)"
if [ -z "$BK_RAW" ]; then
  flag 1 backup_unreadable "backup=unknown"
elif [ "$BK_ENABLED" != "true" ]; then
  flag 1 backup_disabled "backup=off"
elif [ -z "$BK_LAST" ]; then
  flag 2 backup_never_ran "backup=never"
else
  # backup_last_run is epoch milliseconds; tolerate ISO strings too.
  if printf '%s' "$BK_LAST" | grep -qE '^[0-9]+$'; then LAST_S=$((BK_LAST / 1000)); else LAST_S="$(date -d "$BK_LAST" +%s 2>/dev/null || echo 0)"; fi
  AGE_H=$(( ($(date +%s) - LAST_S) / 3600 ))
  field "backup_age_h=$AGE_H"
  WARN_H=$(( BK_INTERVAL * 3 / 2 )); CRIT_H=$(( BK_INTERVAL * 3 ))
  if [ "$BK_STATUS_OK" = "false" ]; then flag 2 backup_failed "backup=failed"
  elif [ "$AGE_H" -ge "$CRIT_H" ]; then flag 2 backup_stale "backup=stale"
  elif [ "$AGE_H" -ge "$WARN_H" ]; then flag 1 backup_late "backup=late"
  else field "backup=ok"; fi
fi

# ---- 3. disk: root filesystem + document store --------------------------------
DOCS_DIR="$(envget MEMEX_DOCS_DIR)"; DOCS_DIR="${DOCS_DIR:-/srv/memex-documents}"
disk_check() { # disk_check <label> <path>
  local pct
  pct="$(df -P "$2" 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
  [ -n "$pct" ] || { flag 1 "$1_unreadable" "$1=?"; return; }
  if   [ "$pct" -ge 90 ]; then flag 2 "$1_full" "$1=${pct}%"
  elif [ "$pct" -ge 80 ]; then flag 1 "$1_filling" "$1=${pct}%"
  else field "$1=${pct}%"; fi
}
disk_check disk_root /
disk_check disk_docs "$DOCS_DIR"

# ---- 4. TLS certificate days remaining (public mode only) ---------------------
# Let's Encrypt renews ~30 days out, so <21 days means renewal is broken, not slow.
if [ "$MODE" = "public" ]; then
  HOST="${APP_DOMAIN:-$(printf '%s' "$APP_URL" | sed -E 's|^https?://||; s|/.*$||')}"
  if [ -n "$HOST" ]; then
    END="$(echo | timeout 5 openssl s_client -servername "$HOST" -connect 127.0.0.1:443 2>/dev/null \
      | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
    if [ -n "$END" ]; then
      DAYS=$(( ($(date -d "$END" +%s) - $(date +%s)) / 86400 ))
      if   [ "$DAYS" -lt 10 ]; then flag 2 cert_expiring "cert_days=$DAYS"
      elif [ "$DAYS" -lt 21 ]; then flag 1 cert_renewal_broken "cert_days=$DAYS"
      else field "cert_days=$DAYS"; fi
    else
      flag 2 cert_unreadable "cert_days=?"
    fi
  fi
fi

# ---- 5. running version vs. the tag the fleet last deployed here --------------
if [ -n "$VERSION" ]; then
  field "version=$VERSION"
  EXPECTED="$(cat "$PARA_DIR/expected-tag" 2>/dev/null || true)"
  if [ -n "$EXPECTED" ]; then
    if [ "$VERSION" = "$EXPECTED" ]; then field "expected=match"
    else flag 1 version_drift "expected=$EXPECTED"; fi
  fi
fi

# ---- 6. WAN IP drift ("static" IPs change when ISPs do) -----------------------
if [ -n "${STATIC_IP:-}" ]; then
  WAN="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  if [ -z "$WAN" ]; then field "wan_ip=?"
  elif [ "$WAN" = "$STATIC_IP" ]; then field "wan_ip=match"
  else flag 1 wan_ip_drift "wan_ip=$WAN"; fi
fi

# ---- 7. management overlay ----------------------------------------------------
if have tailscale; then
  TS="$(timeout 5 tailscale status --json 2>/dev/null | jq -r '.Self.Online' 2>/dev/null || true)"
  if [ "$TS" = "true" ]; then field "ts=online"; else flag 1 tailscale_offline "ts=offline"; fi
fi

# ---- status line --------------------------------------------------------------
case "$STATUS" in 0) WORD=OK ;; 1) WORD=WARN ;; *) WORD=CRIT ;; esac
LINE="DEPOT $WORD ${FIELDS[*]}"
[ "${#REASONS[@]}" -gt 0 ] && LINE="$LINE reasons=$(IFS=,; echo "${REASONS[*]}")"
echo "$LINE"
exit "$STATUS"
