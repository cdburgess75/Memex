#!/bin/sh
# Runs in the keycloak-predump service (docker-compose.yml) every time Keycloak is
# (re)started, before it. Keycloak migrates its database on the first start of a newer
# version and cannot be moved back afterwards, so when the version about to start is
# newer than the one that last wrote the database, take a dump of the Keycloak database
# first. The dump is what a rollback restores; without it a rollback has nothing to go to.
#
# Started by compose, not by upgrade.sh, on purpose: the upgrade.sh that is running on a
# box is the one from BEFORE the release that brings a newer Keycloak, and an old script
# cannot be taught new steps. Whatever brings the stack up (upgrade.sh, ring-update.sh,
# a plain `docker compose up -d`), this runs first.
#
# Exits non-zero, which keeps Keycloak stopped and its database untouched, when the dump
# fails, or when the database was written by a NEWER Keycloak than the one starting (a
# rollback that skipped restoring the dump; see scripts/keycloak-restore.sh).
set -eu
umask 077

target="${KC_IMAGE##*:}"            # quay.io/keycloak/keycloak:26.8.1 -> 26.8.1
export PGHOST=postgres PGUSER=memex PGDATABASE=keycloak

# A fresh install has no Keycloak tables yet: nothing to keep. A database that cannot
# be read at all stops here (set -e) rather than passing for a fresh one.
if [ "$(psql -XAtc "SELECT to_regclass('public.migration_model') IS NOT NULL")" != "t" ]; then
  echo "keycloak-predump: no Keycloak tables yet, nothing to keep"; exit 0
fi
# The newest version that migrated this database.
current="$(psql -XAtc "SELECT version FROM migration_model ORDER BY update_time DESC, version DESC LIMIT 1")"
[ -n "$current" ] || { echo "keycloak-predump: Keycloak's tables are there but record no version; not starting it blind." >&2; exit 1; }

# -1, 0 or 1 as $1 is older than, the same as, or newer than $2 (numeric, dot by dot).
vcmp() {
  awk -v a="$1" -v b="$2" 'BEGIN { n = split(a, x, "."); m = split(b, y, "."); if (m > n) n = m
    for (i = 1; i <= n; i++) { if (x[i] + 0 < y[i] + 0) { print -1; exit } if (x[i] + 0 > y[i] + 0) { print 1; exit } }
    print 0 }'
}

case "$(vcmp "$current" "$target")" in
  0) echo "keycloak-predump: database already at $current, nothing to do"; exit 0 ;;
  1)
    echo "keycloak-predump: the Keycloak database was migrated by Keycloak $current, and $target is older." >&2
    echo "keycloak-predump: an older Keycloak cannot run on it. Restore the dump taken before that upgrade" >&2
    echo "keycloak-predump: (scripts/keycloak-restore.sh keycloak-dumps/<file>), or stay on $current." >&2
    exit 1 ;;
esac

out="/dumps/keycloak-$current-before-$target-$(date -u +%Y%m%dT%H%M%SZ).dump"
echo "keycloak-predump: Keycloak $current -> $target; dumping the Keycloak database first"
if ! pg_dump -Fc -f "$out.part" || ! pg_restore --list "$out.part" >/dev/null; then
  rm -f "$out.part"
  echo "keycloak-predump: the dump FAILED, so Keycloak $target is not started and the database is untouched." >&2
  exit 1
fi
mv "$out.part" "$out"
echo "keycloak-predump: saved keycloak-dumps/$(basename "$out") ($(du -h "$out" | cut -f1))"
echo "keycloak-predump: to go back to Keycloak $current: KC_RESTORE_DUMP=keycloak-dumps/$(basename "$out") ./upgrade.sh <previous tag>"
echo "keycloak-predump: (or, after the app alone was rolled back: scripts/keycloak-restore.sh keycloak-dumps/$(basename "$out"))"
