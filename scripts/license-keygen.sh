#!/usr/bin/env bash
# Generate the Ptech license signing key pair (Ed25519). Run this ONCE, on a
# machine you control. Keep the PRIVATE key secret — it is the only thing that can
# mint licenses. The PUBLIC key ships to every Memex deployment (via the
# LICENSE_PUBLIC_KEY env / setting) so it can verify but never issue a license.
set -euo pipefail

OUT_DIR="${1:-.}"
PRIV="$OUT_DIR/ptech-license-private.pem"
PUB="$OUT_DIR/ptech-license-public.pem"

if [[ -e "$PRIV" ]]; then
  echo "Refusing to overwrite existing $PRIV" >&2
  exit 1
fi

openssl genpkey -algorithm ed25519 -out "$PRIV"
chmod 600 "$PRIV"
openssl pkey -in "$PRIV" -pubout -out "$PUB"

echo "Wrote:"
echo "  private (KEEP SECRET): $PRIV"
echo "  public  (ship to apps): $PUB"
echo
echo "Give every Memex deployment the PUBLIC key, e.g. in docker-compose:"
echo "  environment:"
echo "    LICENSE_PUBLIC_KEY: |"
echo "$(sed 's/^/      /' "$PUB")"
echo
echo "Then mint a license per customer:"
echo "  node scripts/sign-license.js customer.json $PRIV > license.json"
