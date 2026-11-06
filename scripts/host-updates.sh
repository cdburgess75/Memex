#!/usr/bin/env bash
#
# Keeps the server under Depot patched: Ubuntu, Docker and Tailscale update every night,
# and the server restarts itself at 2:30 a.m. Central when an update needs a restart.
#
#   ./scripts/host-updates.sh --install        set it up (Ubuntu, root); install.sh and upgrade.sh run this
#   ./scripts/host-updates.sh --report         tell Depot how updates are going (Admin › Health)
#   ./scripts/host-updates.sh --json           print the same facts (depot-check reads these)
#   ./scripts/host-updates.sh --reboot-if-due  what the 2:30 a.m. timer runs
#
# The nightly install itself is Ubuntu's own unattended-upgrades; this script only widens
# what it may install and takes the restart over from it, so that a restart never lands
# in working hours (7 a.m.-6 p.m. Central) and the boxes restart in ring order:
#
#   UPDATE_RING=0 in .env   restart the same night (ParaTech: the box that goes first)
#   anything else           restart only once the restart has waited ~a day, so the
#                           ring-0 box has been through the same updates a night earlier
#
# Hold every restart on this box:  touch /etc/depot/hold-reboot   (rm it to let go)
#
# Containers keep running while Docker itself updates (live-restore), and come back
# after a restart on their own (restart: unless-stopped, Docker enabled at boot).
set -uo pipefail
# System directories last, not first: the tests put stand-ins for apt and systemctl ahead of them.
PATH="${PATH:+$PATH:}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The paths can be pointed elsewhere for the tests (server/__tests__/lib/hostUpdates.test.js).
APT_CONF="${DEPOT_APT_CONF:-/etc/apt/apt.conf.d/52depot-unattended}"
STATE_DIR="${DEPOT_STATE_DIR:-/var/lib/depot}"
SINCE_FILE="$STATE_DIR/reboot-required-since"
LAST_REBOOT_FILE="$STATE_DIR/last-reboot"
HOLD_FILE="${DEPOT_HOLD_FILE:-/etc/depot/hold-reboot}"
REBOOT_FLAG="${DEPOT_REBOOT_FLAG:-/var/run/reboot-required}"
UU_LOG="${DEPOT_UU_LOG:-/var/log/unattended-upgrades/unattended-upgrades.log}"
WINDOW="02:30"                 # America/Chicago — keep in step with the timer below
WINDOW_WORDS="2:30 a.m. Central"
LATE_RING_WAIT_H=20

say(){ echo "host-updates: $*"; }
envget(){ sed -n "s/^$1=//p" "$ROOT/.env" 2>/dev/null | head -1; }
ring(){ local r; r="$(envget UPDATE_RING)"; case "$r" in ''|*[!0-9]*) echo 1 ;; *) echo "$r" ;; esac; }
wait_hours(){ [ "$(ring)" = "0" ] && echo 0 || echo "$LATE_RING_WAIT_H"; }

can_manage(){
  [ "$(uname -s)" = "Linux" ] && [ "$(id -u)" = "0" ] && command -v apt-get >/dev/null 2>&1 \
    && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

# Remember when a restart first became necessary. Ubuntu rewrites /var/run/reboot-required
# on every update that needs one, so its own date keeps moving; this one does not.
track_since(){
  mkdir -p "$STATE_DIR" 2>/dev/null || return 0
  if [ -f "$REBOOT_FLAG" ]; then
    # First sight: the flag's own date is the best guess at when it appeared.
    [ -s "$SINCE_FILE" ] || date -r "$REBOOT_FLAG" +%s > "$SINCE_FILE" 2>/dev/null || date -u +%s > "$SINCE_FILE"
  else
    rm -f "$SINCE_FILE"
  fi
}

# ── facts ────────────────────────────────────────────────────────────────────
collect_json(){
  track_since
  local live="" dver=""
  if command -v docker >/dev/null 2>&1; then
    dver="$(timeout 10 docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
    live="$(timeout 10 docker info --format '{{.LiveRestoreEnabled}}' 2>/dev/null || true)"
  fi
  local pending; pending="$(apt list --upgradable 2>/dev/null | tail -n +2 || true)"
  MANAGED="$([ -f "$APT_CONF" ] && echo 1 || echo 0)" RING="$(ring)" WAIT_H="$(wait_hours)" \
  HELD="$([ -f "$HOLD_FILE" ] && echo 1 || echo 0)" DOCKER_VERSION="$dver" LIVE_RESTORE="$live" \
  PENDING="$pending" REBOOT_FLAG="$REBOOT_FLAG" UU_LOG="$UU_LOG" WINDOW_WORDS="$WINDOW_WORDS" SINCE_FILE="$SINCE_FILE" LAST_REBOOT_FILE="$LAST_REBOOT_FILE" \
  python3 - <<'PY'
import glob, json, os, re, subprocess, time
from datetime import datetime, timezone

def iso(ts): return datetime.fromtimestamp(ts, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ') if ts else None
def read(p):
    try:
        with open(p) as f: return f.read().strip()
    except OSError: return ''

# The last run of unattended-upgrades, from its own log: when it started, and whether it
# finished cleanly. Everything after the last "Starting" line belongs to that run.
last = {'started_at': None, 'result': 'none', 'message': None}
lines = read(os.environ['UU_LOG']).splitlines()
starts = [i for i, l in enumerate(lines) if 'Starting unattended upgrades script' in l]
if starts:
    run = lines[starts[-1]:]
    m = re.match(r'(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)', run[0])
    if m: last['started_at'] = iso(time.mktime(time.strptime(m.group(1), '%Y-%m-%d %H:%M:%S')))  # the log is in local time
    errors = [l.split(' ERROR ', 1)[1].strip() for l in run if ' ERROR ' in l]
    finished = any(('All upgrades installed' in l) or ('No packages found that can be upgraded' in l) for l in run)
    if errors:
        last['result'], last['message'] = 'failed', errors[-1][:300]
    elif finished:
        last['result'] = 'ok'
    else:
        last['result'] = 'running_or_stopped'

pending = [l for l in os.environ.get('PENDING', '').splitlines() if '/' in l]
security = [l for l in pending if '-security' in l.split(' ', 1)[0]]

def kver(p): return os.path.basename(p)[len('vmlinuz-'):]
def vkey(v): return [int(x) if x.isdigit() else x for x in re.split(r'[.-]', v)]
kernels = sorted((kver(p) for p in glob.glob('/boot/vmlinuz-*')), key=vkey)

os_name = ''
for l in read('/etc/os-release').splitlines():
    if l.startswith('PRETTY_NAME='): os_name = l.split('=', 1)[1].strip('"')

since = read(os.environ['SINCE_FILE'])
required = os.path.exists(os.environ['REBOOT_FLAG'])
boot = None
try:
    with open('/proc/uptime') as f: boot = time.time() - float(f.read().split()[0])
except OSError: pass

print(json.dumps({
    'reported_at': iso(time.time()),
    'managed': os.environ.get('MANAGED') == '1',
    'os': os_name,
    'kernel_running': os.uname().release,
    'kernel_installed': kernels[-1] if kernels else None,
    'last_boot': iso(boot),
    'last_run': last,
    'pending': {'total': len(pending), 'security': len(security)},
    'reboot': {
        'required': required,
        'since': iso(int(since)) if required and since.isdigit() else None,
        'packages': sorted(set(read(os.environ['REBOOT_FLAG'] + '.pkgs').split())) if required else [],
        'ring': int(os.environ.get('RING') or 1),
        'wait_hours': int(os.environ.get('WAIT_H') or 0),
        'held': os.environ.get('HELD') == '1',
        'window': os.environ.get('WINDOW_WORDS'),
        'last_reason': read(os.environ['LAST_REBOOT_FILE']) or None,
    },
    'docker': {'version': os.environ.get('DOCKER_VERSION') or None,
               'live_restore': {'true': True, 'false': False}.get(os.environ.get('LIVE_RESTORE', ''), None)},
}))
PY
}

# Hand the facts to Depot (Admin › Health). Same route editor-switch.sh uses the other
# way: the app has no access to the host, so the host writes one row in the database.
report(){
  local json DC COMPOSE MODE
  json="$(collect_json)" || return 0
  cd "$ROOT" 2>/dev/null && [ -f .env ] && [ -f docker-compose.yml ] || { printf '%s\n' "$json"; return 0; }
  if docker compose version >/dev/null 2>&1; then DC="docker compose"; else return 0; fi
  MODE="$(envget MEMEX_MODE)"; [ -n "$MODE" ] || MODE="$(grep -q '^TRUST_PROXY=1' .env && echo public || echo local)"
  COMPOSE="-f docker-compose.yml"; [ "$MODE" = "public" ] && COMPOSE="$COMPOSE -f docker-compose.prod.yml"
  # psql only expands :'v' in what it reads, not in -c, so the statement goes in on stdin.
  # shellcheck disable=SC2086
  printf '%s\n' "INSERT INTO system_settings (key, value, updated_at) VALUES ('host_updates', :'v', now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();" \
    | timeout 30 $DC $COMPOSE exec -T postgres psql -U memex -d memex -q -v ON_ERROR_STOP=1 -v v="$json" >/dev/null 2>&1 \
    || say "could not reach the database - Admin › Health keeps the last report"
}

# ── the 2:30 a.m. restart ────────────────────────────────────────────────────
reboot_if_due(){
  track_since
  report
  [ -f "$REBOOT_FLAG" ] || { say "no restart needed"; return 0; }
  if [ -f "$HOLD_FILE" ]; then say "a restart is waiting, but restarts are held ($HOLD_FILE)"; return 0; fi
  local since age_h need
  since="$(cat "$SINCE_FILE" 2>/dev/null)"; since="${since:-$(date -u +%s)}"
  age_h=$(( ($(date -u +%s) - since) / 3600 )); need="$(wait_hours)"
  if [ "$age_h" -lt "$need" ]; then
    say "a restart has waited ${age_h} h; this box (ring $(ring)) waits ${need} h, so it restarts tomorrow night"
    return 0
  fi
  # Never restart in the middle of an install: leave it for tomorrow night.
  if pgrep -f 'unattended-upgrade' >/dev/null 2>&1 || pgrep -x 'apt-get|dpkg' >/dev/null 2>&1; then
    say "updates are still installing - restarting tomorrow night instead"; return 0
  fi
  mkdir -p "$STATE_DIR"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(tr '\n' ' ' < "$REBOOT_FLAG.pkgs" 2>/dev/null)" > "$LAST_REBOOT_FILE"
  say "restarting to finish updates ($(tr '\n' ' ' < "$REBOOT_FLAG.pkgs" 2>/dev/null))"
  logger -t depot "host-updates: restarting to finish updates"
  systemctl reboot
}

# ── setup ────────────────────────────────────────────────────────────────────
install_all(){
  if ! can_manage; then
    say "not setting up automatic updates (needs Ubuntu with systemd, as root)."
    return 0
  fi
  dpkg -s unattended-upgrades >/dev/null 2>&1 || apt-get install -y -qq unattended-upgrades </dev/null >/dev/null 2>&1 \
    || say "could not install unattended-upgrades"
  command -v jq >/dev/null 2>&1 || apt-get install -y -qq jq </dev/null >/dev/null 2>&1 || true

  local tmp; tmp="$(mktemp)"
  cat > "$tmp" <<'APT'
// Depot (scripts/host-updates.sh --install). Rewritten on every Depot update: put local
// changes in a file that sorts after this one, such as 60local-unattended.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
// Ubuntu's defaults allow security fixes only. Depot boxes also take Ubuntu's ordinary
// fixes, Docker and Tailscale, so nothing piles up waiting for somebody to log in.
Unattended-Upgrade::Origins-Pattern {
        "origin=Ubuntu,archive=${distro_codename}-security,label=Ubuntu";
        "origin=Ubuntu,archive=${distro_codename}-updates,label=Ubuntu";
        "origin=Docker,label=Docker CE";
        "origin=Tailscale,label=Tailscale";
};
// Depot restarts the server itself, at 2:30 a.m. Central and in ring order
// (depot-reboot.timer), never in the middle of the working day.
Unattended-Upgrade::Automatic-Reboot "false";
APT
  if ! cmp -s "$tmp" "$APT_CONF"; then install -m 644 "$tmp" "$APT_CONF" && say "updated $APT_CONF"; fi
  rm -f "$tmp"
  systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || true

  # Containers keep running while Docker itself updates. live-restore is one of the few
  # settings Docker takes on a reload, so turning it on stops nothing.
  local rc=0
  mkdir -p /etc/docker
  python3 - /etc/docker/daemon.json <<'PY' || rc=$?
import json, os, sys
p = sys.argv[1]
d = {}
if os.path.exists(p) and os.path.getsize(p):
    with open(p) as f: d = json.load(f)
if d.get('live-restore') is True: sys.exit(3)
d['live-restore'] = True
with open(p + '.new', 'w') as f: json.dump(d, f, indent=2); f.write('\n')
os.replace(p + '.new', p)
PY
  case "$rc" in
    0) systemctl reload docker && say "Docker: containers now keep running while Docker updates (live-restore)" \
         || say "Docker did not take live-restore on a reload; it applies at the next restart" ;;
    3) : ;;
    *) say "left /etc/docker/daemon.json alone (it could not be read as JSON)" ;;
  esac

  local unit=/etc/systemd/system changed=0 f
  write_unit(){ # write_unit <file> <content>
    if [ "$(cat "$unit/$1" 2>/dev/null)" != "$2" ]; then printf '%s\n' "$2" > "$unit/$1"; changed=1; fi
  }
  write_unit depot-reboot.service "[Unit]
Description=Depot: restart the server if an update is waiting for one

[Service]
Type=oneshot
ExecStart=$ROOT/scripts/host-updates.sh --reboot-if-due"
  # Persistent=false: a missed window is skipped, never made up at boot or mid-morning.
  write_unit depot-reboot.timer "[Unit]
Description=Depot: restart window, $WINDOW_WORDS

[Timer]
OnCalendar=*-*-* $WINDOW:00 America/Chicago
Persistent=false

[Install]
WantedBy=timers.target"
  write_unit depot-host-report.service "[Unit]
Description=Depot: report how operating system updates are going
After=docker.service

[Service]
Type=oneshot
ExecStart=$ROOT/scripts/host-updates.sh --report"
  write_unit depot-host-report.timer "[Unit]
Description=Depot: report how operating system updates are going, hourly and after boot

[Timer]
OnBootSec=5min
OnCalendar=hourly
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target"
  [ "$changed" = 1 ] && systemctl daemon-reload
  systemctl enable --now depot-reboot.timer depot-host-report.timer >/dev/null 2>&1 \
    && say "nightly updates on; restarts at $WINDOW_WORDS (ring $(ring), waits $(wait_hours) h)" \
    || say "could not enable the Depot timers"

  # The RMM check travels with the release too, so every box runs the current one.
  [ -f "$ROOT/scripts/depot-check.sh" ] && install -m 755 "$ROOT/scripts/depot-check.sh" /usr/local/bin/depot-check
  report
}

case "${1:-}" in
  --install) install_all ;;
  --report) report ;;
  --json) collect_json ;;
  --reboot-if-due) reboot_if_due ;;
  *) sed -n '3,9p' "$0"; exit 2 ;;
esac
exit 0
