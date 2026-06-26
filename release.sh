#!/usr/bin/env bash
#
# Cut a Memex release: bump VERSION, commit, tag vYYYY.MM.DD.NNN, and push.
# Pushing the vX.Y.Z tag triggers the GHCR workflow to publish a pinned
# multi-arch image (and main gets :latest).
#
#   ./release.sh                  # auto: today's date, next sequence number
#   ./release.sh v2026.06.26.003  # explicit version
#   ./release.sh -n               # dry-run (print what it would do)
#
set -euo pipefail
cd "$(dirname "$0")"

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=; G=; Y=; R=; N=; fi
info(){ printf '%s==>%s %s\n' "$G$B" "$N" "$*"; }
warn(){ printf '%s !%s %s\n'  "$Y$B" "$N" "$*"; }
die(){  printf '%s x%s %s\n'  "$R$B" "$N" "$*" >&2; exit 1; }

DRY=0; VER=""
for a in "$@"; do
  case "$a" in
    -n|--dry-run) DRY=1 ;;
    v*) VER="$a" ;;
    *) die "Unknown argument: $a (use vYYYY.MM.DD.NNN or -n)" ;;
  esac
done

[ -f VERSION ] && [ -d .git ] || die "Run this from the Memex repo root."

# Auto-compute the next version for today if none was given.
if [ -z "$VER" ]; then
  DATE="$(date +%Y.%m.%d)"
  maxn=0
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    n="${t##*.}"; case "$n" in *[!0-9]*) continue ;; esac
    n=$((10#$n)); [ "$n" -gt "$maxn" ] && maxn=$n
  done < <(git tag -l "v$DATE.*")
  VER="$(printf 'v%s.%03d' "$DATE" $((maxn + 1)))"
fi

case "$VER" in
  v[0-9][0-9][0-9][0-9].[0-9][0-9].[0-9][0-9].[0-9][0-9][0-9]) : ;;
  *) die "Version must look like vYYYY.MM.DD.NNN (got: $VER)" ;;
esac
git rev-parse -q --verify "refs/tags/$VER" >/dev/null 2>&1 && die "Tag $VER already exists."

CUR="$(cat VERSION)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
info "Release: $CUR → ${B}$VER${N}  (branch: $BRANCH)"

# A release should be cut from a clean tree — only VERSION should change.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  die "Working tree has uncommitted changes. Commit or stash them first so they don't get mixed into the release commit."
fi

if [ "$DRY" = "1" ]; then
  info "[dry-run] would: write VERSION=$VER, commit \"Release $VER\", tag $VER, push $BRANCH + tag."
  exit 0
fi

printf '%s\n' "$VER" > VERSION
git add VERSION
git commit -q -m "Release $VER"
git tag -a "$VER" -m "Memex $VER"
info "Pushing $BRANCH and tag $VER…"
git push origin "$BRANCH"
git push origin "refs/tags/$VER"

echo
info "Released ${B}$VER${N}. GHCR is now building multi-arch :$VER (+ :latest)."
echo "    Watch:   https://github.com/cdburgess75/Memex/actions"
echo "    Deploy:  ./upgrade.sh $VER   (on each host)"
