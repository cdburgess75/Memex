#!/usr/bin/env bash
# depot-drive -- open Depot as a drive on this computer, signed in the way the website is.
#
#   depot-drive setup https://depot.example.com   sign in once (your browser opens) and save the connection
#   depot-drive mount [folder]                      open the drive (default ~/Depot); Ctrl-C closes it
#   depot-drive status                              who is signed in, and to which Depot
#   depot-drive signout                             forget the sign-in
#   depot-drive token                               print a fresh access token (rclone runs this itself)
#
# Needs curl (built in) and, to open the drive, rclone from https://rclone.org/install/.
# On a Mac the drive is served to Finder over NFS, so nothing else is needed; on Linux,
# FUSE (the fuse3 package). The sign-in is kept in the Keychain on a Mac and in a private
# file on Linux, and renewed on its own; it ends after 30 days unused, or when an
# administrator switches you off. Served by every Depot at <depot>/api/docs/depot-drive.sh.
set -eu

CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/depot-drive"
CONF="$CONF_DIR/connection"
REMOTE="depot"
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
URL=""; HOST=""; KEYCLOAK=""; REALM=""; CLIENT=""

say() { printf '%s\n' "$*" >&2; }
die() { say "depot-drive: $*"; exit 1; }
# A string or number field of the flat JSON these endpoints answer with.
field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -n 1; }
number() { sed -n "s/.*\"$1\":\([0-9][0-9]*\).*/\1/p" | head -n 1; }
is_mac() { [ "$(uname)" = Darwin ]; }

load() { [ -f "$CONF" ] || die "not set up yet. Run: depot-drive setup https://your-depot"; . "$CONF"; }
keep_secret() {
  if is_mac; then security add-generic-password -U -a "$USER" -s "depot-drive:$HOST" -w "$1"
  else (umask 077; printf '%s' "$1" > "$CONF_DIR/signin"); fi
}
read_secret() {
  if is_mac; then security find-generic-password -a "$USER" -s "depot-drive:$HOST" -w 2>/dev/null || true
  else cat "$CONF_DIR/signin" 2>/dev/null || true; fi
}
drop_secret() {
  if is_mac; then security delete-generic-password -a "$USER" -s "depot-drive:$HOST" >/dev/null 2>&1 || true
  else rm -f "$CONF_DIR/signin"; fi
}
open_url() {
  if [ -n "${DEPOT_DRIVE_NO_BROWSER:-}" ]; then say "Open this in a browser: $1"   # a computer with no browser of its own
  elif command -v open >/dev/null 2>&1; then open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 || say "Open this in your browser: $1"
  else say "Open this in your browser: $1"; fi
}
token_endpoint() { printf '%s/realms/%s/protocol/openid-connect/token' "$KEYCLOAK" "$REALM"; }
whoami_email() { curl -sS -H "Authorization: Bearer $1" "$KEYCLOAK/realms/$REALM/protocol/openid-connect/userinfo" | field email; }

setup() {
  URL="${1:-}"; [ -n "$URL" ] || die "give your Depot's address, e.g. depot-drive setup https://depot.example.com"
  URL="${URL%/}"; case "$URL" in http://*|https://*) ;; *) URL="https://$URL" ;; esac
  cfg="$(curl -fsS "$URL/api/config")" || die "could not reach $URL"
  KEYCLOAK="$(printf '%s' "$cfg" | field keycloakUrl)"; REALM="$(printf '%s' "$cfg" | field keycloakRealm)"; CLIENT="$(printf '%s' "$cfg" | field driveClientId)"
  [ -n "$KEYCLOAK" ] && [ -n "$REALM" ] && [ -n "$CLIENT" ] || die "$URL does not offer the drive (an older Depot?)"
  HOST="$(printf '%s' "$URL" | sed 's|^https*://||')"
  dev="$(curl -fsS -X POST "$KEYCLOAK/realms/$REALM/protocol/openid-connect/auth/device" -d "client_id=$CLIENT" -d "scope=openid offline_access")" \
    || die "Depot's sign-in service did not answer"
  code="$(printf '%s' "$dev" | field device_code)"; user_code="$(printf '%s' "$dev" | field user_code)"
  verify="$(printf '%s' "$dev" | field verification_uri_complete)"; [ -n "$verify" ] || verify="$(printf '%s' "$dev" | field verification_uri)"
  interval="$(printf '%s' "$dev" | number interval)"; [ -n "$interval" ] || interval=5
  say "Sign in to Depot in the browser window that opens (the code there is $user_code). Waiting..."
  open_url "$verify"
  while :; do
    sleep "$interval"
    tok="$(curl -sS -X POST "$(token_endpoint)" -d grant_type=urn:ietf:params:oauth:grant-type:device_code -d "client_id=$CLIENT" -d "device_code=$code")"
    access="$(printf '%s' "$tok" | field access_token)"
    [ -z "$access" ] || break
    case "$(printf '%s' "$tok" | field error)" in
      authorization_pending) ;;
      slow_down) interval=$((interval + 5)) ;;
      *) die "the sign-in did not finish: $(printf '%s' "$tok" | field error_description)" ;;
    esac
  done
  refresh="$(printf '%s' "$tok" | field refresh_token)"; [ -n "$refresh" ] || die "no lasting sign-in came back"
  mkdir -p "$CONF_DIR"; chmod 700 "$CONF_DIR"
  printf "URL='%s'\nHOST='%s'\nKEYCLOAK='%s'\nREALM='%s'\nCLIENT='%s'\n" "$URL" "$HOST" "$KEYCLOAK" "$REALM" "$CLIENT" > "$CONF"
  keep_secret "$refresh"
  say "Signed in to $URL as $(whoami_email "$access")."
  configure_rclone
}

# rclone asks this program for a token whenever Depot wants a fresh one.
configure_rclone() {
  command -v rclone >/dev/null 2>&1 || { say "rclone is not installed yet: get it from https://rclone.org/install/ and then run: depot-drive mount"; return 0; }
  case "$SELF" in *' '*) die "this program sits in a folder with a space in its name; move it (to ~/.local/bin, say) and run setup again" ;; esac
  if rclone listremotes 2>/dev/null | grep -qx "$REMOTE:"; then
    rclone config update "$REMOTE" url="$URL/dav/" vendor=other user= pass= bearer_token= bearer_token_command="$SELF token" >/dev/null
  else
    rclone config create "$REMOTE" webdav url="$URL/dav/" vendor=other bearer_token_command="$SELF token" >/dev/null
  fi
  say "Depot is set up for rclone as \"$REMOTE:\". Open it with: depot-drive mount"
}

token() {
  load
  refresh="$(read_secret)"; [ -n "$refresh" ] || die "not signed in. Run: depot-drive setup $URL"
  tok="$(curl -sS -X POST "$(token_endpoint)" -d grant_type=refresh_token -d "client_id=$CLIENT" -d "refresh_token=$refresh")"
  access="$(printf '%s' "$tok" | field access_token)"
  [ -n "$access" ] || die "your Depot sign-in has ended ($(printf '%s' "$tok" | field error)). Run: depot-drive setup $URL"
  new="$(printf '%s' "$tok" | field refresh_token)"
  if [ -n "$new" ] && [ "$new" != "$refresh" ]; then keep_secret "$new"; fi
  printf '%s\n' "$access"
}

mount_drive() {
  load
  command -v rclone >/dev/null 2>&1 || die "rclone is not installed: get it from https://rclone.org/install/"
  rclone listremotes 2>/dev/null | grep -qx "$REMOTE:" || configure_rclone
  dir="${1:-$HOME/Depot}"; mkdir -p "$dir"
  say "Opening Depot at $dir. Leave this running; Ctrl-C closes the drive."
  if is_mac; then exec rclone nfsmount "$REMOTE:" "$dir" --vfs-cache-mode full --volname Depot
  else exec rclone mount "$REMOTE:" "$dir" --vfs-cache-mode full; fi
}

status() {
  load
  access="$(token 2>/dev/null)" || { say "Set up for $URL, but not signed in. Run: depot-drive setup $URL"; exit 1; }
  say "Signed in to $URL as $(whoami_email "$access")."
}

signout() {
  load
  refresh="$(read_secret)"
  [ -z "$refresh" ] || curl -sS -o /dev/null -X POST "$KEYCLOAK/realms/$REALM/protocol/openid-connect/logout" -d "client_id=$CLIENT" -d "refresh_token=$refresh" || true
  drop_secret
  say "Signed out of $URL on this computer."
}

usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

case "${1:-}" in
  setup) shift; setup "$@" ;;
  mount) shift; mount_drive "$@" ;;
  token) token ;;
  status) status ;;
  signout) signout ;;
  *) usage ;;
esac
