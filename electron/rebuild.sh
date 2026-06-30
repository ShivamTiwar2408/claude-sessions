#!/bin/bash
# rebuild.sh — build Claude Sessions and reinstall it to /Applications,
# always deleting the previous install first so there's never a stale copy.
#
# Usage:  cd electron && ./rebuild.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

APP_NAME="Claude Sessions"
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

echo "==> Clearing Gatekeeper quarantine (local build)…"
xattr -dr com.apple.quarantine "$INSTALLED" 2>/dev/null || true

# Show what we just installed so it's obvious the version is fresh.
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"
echo "==> Installed: $INSTALLED"
echo "    app.asar:  $(ls -la "$INSTALLED/Contents/Resources/app.asar" | awk '{print $5" bytes, "$6" "$7" "$8}')"
echo "    finished:  $STAMP"
echo ""
echo "Done. Launch it from Spotlight or the dock — it's the only copy now."
