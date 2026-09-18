#!/bin/bash
# Manual fleet-update sequence (runbook §6). Usage: ring-update.sh <tag>
#
# Backups are REPORTED here, never a gate (decision 2026-09-17): a box whose backup
# destination is failing still needs its updates, and twice in one day a front-end-only
# release was held up by this script until someone went around it with upgrade.sh. So a
# backup-only depot-check reason, or a failed pre-update backup, is a loud WARN and the
# update carries on. Anything else depot-check flags (healthz, disk, cert) still aborts.
set -uo pipefail
TAG="${1:?usage: ring-update.sh <tag>}"
cd /opt/memex
C="-f docker-compose.yml -f docker-compose.prod.yml"
step(){ echo; echo "== $*"; }
warn(){ echo "WARN: $*" >&2; WARNED=1; }
WARNED=0

step "1. preflight: depot-check"
CHECK="$(/usr/local/bin/depot-check)"; RC=$?
echo "$CHECK"
if [ $RC -ne 0 ]; then
  REASONS="$(printf '%s\n' "$CHECK" | sed -n 's/.*reasons=\([^ ]*\).*/\1/p')"
  OTHER="$(printf '%s\n' "$REASONS" | tr ',' '\n' | grep -v '^backup_' | grep -v '^$' || true)"
  if [ -z "$REASONS" ] || [ -n "$OTHER" ]; then echo "ABORT: box not green before update (${OTHER:-no reasons given})"; exit 1; fi
  warn "backups need attention ($REASONS) - continuing; this box may have no current backup"
fi

step "2. pre-update backup (synchronous, best effort)"
docker compose $C exec -T app node -e 'require("./server/lib/backup").runBackup({manual:true}).then(r=>{const bad=(r.destinations||[]).filter(d=>d.ok===false).map(d=>(d.label||d.type)+": "+d.error);console.log(JSON.stringify({ok:r.ok,name:r.name||null,failed:bad}));process.exit(r.ok===false?1:0)}).catch(e=>{console.log(JSON.stringify({ok:false,error:e.message}));process.exit(1)})' \
  || warn "pre-update backup failed (see the line above for why) - continuing WITHOUT a fresh backup"

step "3. rollback point"
PREV=$(sed -n 's/^MEMEX_TAG=//p' .env)
mkdir -p .paratech
cp .env ".paratech/env.pre-$TAG"
echo "previous tag: $PREV (env snapshot saved)"

step "4. upgrade.sh $TAG"
./upgrade.sh "$TAG" || { echo "UPGRADE FAILED — rollback: ./upgrade.sh $PREV"; exit 1; }

step "5. migration verification"
docker compose $C exec -T app node -e '(async()=>{const m=require("./server/lib/migrations"),db=require("./server/lib/db");const files=m.migrationFiles();const rows=await db.query("SELECT name FROM schema_migrations");const applied=new Set(rows.map(r=>r.name));const missing=files.filter(f=>!applied.has(f));console.log(JSON.stringify({files:files.length,applied:applied.size,missing}));process.exit(missing.length?1:0)})()' \
  || { echo "ABORT: migrations incomplete — rollback: ./upgrade.sh $PREV"; exit 1; }

step "6. health + version confirm"
ok=0; for i in $(seq 1 40); do
  V=$(curl -s -m3 http://127.0.0.1:3000/healthz | jq -r '.version // empty' 2>/dev/null)
  [ "$V" = "$TAG" ] && { ok=1; break; }; sleep 3
done
[ $ok = 1 ] || { echo "ABORT: healthz never reported $TAG — rollback: ./upgrade.sh $PREV"; exit 1; }
curl -s -m5 http://127.0.0.1:3000/healthz; echo

step "7. smoke"
D=$(sed -n 's|^APP_URL=https://||p' .env)
for u in "https://$D/" "https://$D/api/config" "https://$D/realms/memex/.well-known/openid-configuration"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m10 --resolve "$D:443:127.0.0.1" "$u")
  echo "  $u -> $code"; [ "$code" = 200 ] || { echo "ABORT: smoke failed on $u — rollback: ./upgrade.sh $PREV"; exit 1; }
done

echo
if [ $WARNED = 1 ]; then echo "DONE with warnings: $TAG is live, but fix the backup warnings above."; else echo "DONE: $TAG is live."; fi
