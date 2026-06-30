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

# Ad-hoc code-sign with a STABLE identifier. macOS ties TCC permission grants
# (Automation / "access data from other apps") to the app's code signature.
# An unsigned app looks brand-new on every rebuild, so the prompt reappears
# each time. A stable ad-hoc signature makes macOS treat every rebuild as the
# SAME app, so you grant the permission once and it sticks.
echo "==> Ad-hoc code-signing (stable identity so the permission prompt is one-time)…"
codesign --force --deep --sign - \
  --identifier "dev.local.claude-session-browser" \
  "$INSTALLED" 2>/dev/null || echo "    (codesign skipped/failed — non-fatal)"

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
