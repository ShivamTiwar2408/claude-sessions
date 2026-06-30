#!/bin/bash
# setup-signing.sh — create a PERSISTENT self-signed code-signing identity in
# your login keychain, used by rebuild.sh to sign the app.
#
# Run this ONCE. After it, the macOS permission prompt ("would like to access
# files…") is granted a single time and STAYS granted across every future
# rebuild — because the app is signed with a stable identity instead of an
# ad-hoc signature (whose hash changes each build and re-triggers the prompt).
#
# Free, fully local. No Apple Developer account needed. The cert never leaves
# this machine and is only trusted for code signing.
set -euo pipefail

CN="Claude Sessions Local Signing"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$CN" >/dev/null 2>&1; then
  echo "✓ Signing identity “$CN” already exists. Nothing to do."
  echo "  (rebuild.sh will use it automatically.)"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PW="csb-local"

echo "==> Generating a self-signed code-signing certificate…"
openssl req -x509 -newkey rsa:2048 -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -days 3650 -nodes -subj "/CN=$CN" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -addext "basicConstraints=critical,CA:false" 2>/dev/null

echo "==> Packaging into PKCS#12…"
openssl pkcs12 -export -out "$TMP/id.p12" -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -passout "pass:$PW" -legacy 2>/dev/null \
  || openssl pkcs12 -export -out "$TMP/id.p12" -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
       -passout "pass:$PW" 2>/dev/null

echo "==> Importing into login keychain (allowing codesign to use it without prompts)…"
security import "$TMP/id.p12" -k "$KEYCHAIN" -P "$PW" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null 2>&1

# Let codesign use the key non-interactively (no per-build keychain password popup).
security set-key-partition-list -S apple-tool:,apple: -s -k "" "$KEYCHAIN" >/dev/null 2>&1 \
  || security set-key-partition-list -S apple-tool:,apple: "$KEYCHAIN" >/dev/null 2>&1 || true

if security find-certificate -c "$CN" >/dev/null 2>&1; then
  echo ""
  echo "✓ Done. Signing identity “$CN” is installed."
  echo "  Next: run ./rebuild.sh, launch the app, and click Allow ONE more time."
  echo "  From then on the permission prompt should not return across rebuilds."
else
  echo "✗ Import did not complete — check Keychain Access for “$CN”." >&2
  exit 1
fi
