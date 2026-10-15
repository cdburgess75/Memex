#!/usr/bin/env bash
# Generate a Ptech license signing key pair (Ed25519). Keep the PRIVATE key secret —
# it is the only thing that can mint licenses — and BACK IT UP: losing it strands
# every future customer. The PUBLIC key ships to every deployment in keys/ so the
# app can verify but never issue a license.
#
#   scripts/license-keygen.sh [out-dir] [name]        default name: ptech-license
#
# Writes <out-dir>/<name>-private.pem and <out-dir>/<name>-public.pem and prints
# the key id (the first 16 hex characters of SHA-256 over the public key's DER),
# which version 2 licenses carry as `kid`. Uses Node rather than openssl: the
# LibreSSL that ships with macOS cannot make Ed25519 keys, and Node is already
# needed for sign-license.js.
#
# To rotate: generate a second pair under a new name, copy its PUBLIC key into
# keys/, ship that in a release, then start signing with it. Licenses signed by the
# old key keep verifying for as long as its public key stays in keys/.
set -euo pipefail

OUT_DIR="${1:-.}"
NAME="${2:-ptech-license}"
PRIV="$OUT_DIR/$NAME-private.pem"
PUB="$OUT_DIR/$NAME-public.pem"

if [[ -e "$PRIV" ]]; then
  echo "Refusing to overwrite existing $PRIV" >&2
  exit 1
fi
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

KID="$(node -e '
const crypto = require("crypto"), fs = require("fs");
const [priv, pub] = process.argv.slice(1);
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
fs.writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
fs.writeFileSync(pub, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
process.stdout.write(crypto.createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16));
' "$PRIV" "$PUB")"
chmod 600 "$PRIV"

echo "Wrote:"
echo "  private (KEEP SECRET, BACK UP): $PRIV"
echo "  public  (ship in keys/):        $PUB"
echo "  key id (kid):                   $KID"
echo
echo "Every deployment trusts each *.pem in its keys/ directory (LICENSE_PUBLIC_KEYS_DIR),"
echo "plus one key given inline as LICENSE_PUBLIC_KEY or by path as LICENSE_PUBLIC_KEY_PATH."
echo
echo "Then mint a license per customer:"
echo "  node scripts/sign-license.js customer.json $PRIV > license.json"
