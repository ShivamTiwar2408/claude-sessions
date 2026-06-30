#!/bin/bash
# rebuild.sh — build Claude Code and reinstall it to /Applications,
# always deleting the previous install first so there's never a stale copy.
#
# Usage:  cd electron && ./rebuild.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

# Ensure `node` is on PATH (electron-builder shells out to it). Covers nvm,
# Homebrew, and standard locations even when run from a non-login shell.
if ! command -v node >/dev/null 2>&1; then
  for d in "$HOME"/.nvm/versions/node/*/bin /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$d/node" ]; then PATH="$d:$PATH"; break; fi
  done
fi
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found on PATH"; exit 1; }

APP_NAME="Claude Code"
INSTALLED="/Applications/${APP_NAME}.app"
BUILT="dist/mac-arm64/${APP_NAME}.app"

echo "==> Stopping any running instances…"
pkill -f "${APP_NAME}.app/Contents/MacOS" 2>/dev/null || true
pkill -f "claude-session-browser/electron/node_modules/electron" 2>/dev/null || true
sleep 1

echo "==> Cleaning previous build output…"
rm -rf dist

echo "==> Building the .app bundle (unsigned)…"
CSC_IDENTITY_AUTO_DISCOVERY=false ./node_modules/.bin/electron-builder --mac dir >/tmp/csb_build.log 2>&1 \
  || { echo "BUILD FAILED — tail of log:"; tail -25 /tmp/csb_build.log; exit 1; }

if [ ! -d "$BUILT" ]; then
  echo "ERROR: expected built app not found at: $BUILT"; exit 1
fi

echo "==> Removing the OLD installed app (avoids stale-version confusion)…"
rm -rf "$INSTALLED"

echo "==> Installing the NEW app to /Applications…"
cp -R "$BUILT" "/Applications/"

# Code-sign with a PERSISTENT self-signed identity so macOS TCC permission
# grants (Files & Folders / Automation) survive rebuilds.
#
# Why not ad-hoc: macOS keys an ad-hoc-signed app's permissions to its cdhash
# (a hash of the bytes), which changes on every rebuild — so "Allow" never
# sticks. A real signing *identity* (even self-signed) lets TCC key the grant
# to the identity, which is stable across rebuilds. The identity is created
# once by setup-signing.sh and lives in the login keychain.
SIGN_ID="Claude Sessions Local Signing"
ENTITLEMENTS="$HERE/entitlements.plist"
if security find-certificate -c "$SIGN_ID" >/dev/null 2>&1; then
  echo "==> Code-signing with persistent identity '$SIGN_ID' (grant persists across rebuilds)…"
  # Sign inner native helpers first (inside-out), then the app bundle.
  find "$INSTALLED/Contents/Frameworks" -type f \( -name "*.dylib" -o -perm +111 \) 2>/dev/null \
    | while read -r f; do codesign --force --timestamp=none --sign "$SIGN_ID" "$f" 2>/dev/null || true; done
  find "$INSTALLED/Contents/Frameworks" -maxdepth 1 -name "*.framework" -o -name "*.app" 2>/dev/null \
    | while read -r b; do codesign --force --timestamp=none --sign "$SIGN_ID" "$b" 2>/dev/null || true; done
  codesign --force --timestamp=none \
    --identifier "dev.local.claude-session-browser" \
    ${ENTITLEMENTS:+--entitlements "$ENTITLEMENTS"} \
    --sign "$SIGN_ID" "$INSTALLED" 2>/tmp/csb_sign.log \
    && echo "    signed ✓ (Authority: $SIGN_ID)" \
    || { echo "    signing failed — see /tmp/csb_sign.log; falling back to ad-hoc"; \
         codesign --force --deep --sign - --identifier "dev.local.claude-session-browser" "$INSTALLED" 2>/dev/null || true; }
else
  echo "==> No persistent signing identity found — run ./setup-signing.sh once to stop"
  echo "    the permission prompt recurring. Falling back to ad-hoc for now…"
  codesign --force --deep --sign - \
    --identifier "dev.local.claude-session-browser" "$INSTALLED" 2>/dev/null || true
fi

echo "==> Clearing Gatekeeper quarantine (local build)…"
xattr -dr com.apple.quarantine "$INSTALLED" 2>/dev/null || true

# Delete the build-output copy so it can't be launched or indexed as a second
# app. electron-builder leaves dist/mac-arm64/<App>.app behind — if we keep it,
# Spotlight/Launch Services shows TWO copies.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"
echo "==> Removing build-output copy and de-registering stray bundles…"
if [ -d "$BUILT" ]; then
  "$LSREGISTER" -u "$BUILT" 2>/dev/null || true   # unregister from Launch Services
fi
rm -rf dist
# Belt-and-suspenders: unregister any "Claude Code"/"Claude Sessions" bundle
# that is NOT the installed one (e.g. a leftover from the old product name),
# so the dock/Spotlight only ever resolves /Applications.
for stray in $("$LSREGISTER" -dump 2>/dev/null | grep -oE "/[^ ]*Claude (Code|Sessions).app" | sort -u); do
  if [ "$stray" != "$INSTALLED" ]; then
    "$LSREGISTER" -u "$stray" 2>/dev/null || true
  fi
done
# Remove any old "Claude Sessions.app" install from the previous product name.
rm -rf "/Applications/Claude Sessions.app" 2>/dev/null || true
# Re-register the installed app so it's the single source of truth.
"$LSREGISTER" -f "$INSTALLED" 2>/dev/null || true

# Show what we just installed so it's obvious the version is fresh.
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"
echo "==> Installed: $INSTALLED"
echo "    app.asar:  $(ls -la "$INSTALLED/Contents/Resources/app.asar" | awk '{print $5" bytes, "$6" "$7" "$8}')"
echo "    finished:  $STAMP"

# Relaunch. We hard-killed all running copies at the top, so a plain `open`
# starts the new build cleanly. We do NOT use `open -n` — that forces a second
# instance, which (combined with the single-instance lock in main.js) is both
# unnecessary and the cause of duplicate dock icons.
echo "==> Launching the new build…"
sleep 1
open "$INSTALLED"

echo ""
echo "Done. The new window is the freshly-built version (it's the only copy installed)."
