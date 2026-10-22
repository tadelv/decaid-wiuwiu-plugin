#!/usr/bin/env bash
# Install / update the Wiu Wiu RGB plugin on a Decaid tablet and enable it.
#
#   ./scripts/deploy.sh                 # push, restart Decaid, enable, preset=rainbow
#   ./scripts/deploy.sh breathing       # same, but select another preset
#   DECAID_HOST=de1tablet.home:8080 DECAID_PACKAGE=net.tadel.reaprime ./scripts/deploy.sh
#
# Requires: adb with the tablet attached, and a debuggable Decaid build (run-as).
set -euo pipefail

HOST="${DECAID_HOST:-de1tablet.home:8080}"
PKG="${DECAID_PACKAGE:-net.tadel.reaprime}"
ID="wiuwiu.reaplugin"
PRESET="${1:-rainbow}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/$ID"
TMP="/data/local/tmp/$ID"

say() { printf '\n== %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ -f "$SRC/manifest.json" ] && [ -f "$SRC/plugin.js" ] || die "plugin files missing in $SRC"
adb get-state >/dev/null 2>&1 || die "no adb device attached"

# Refuse to deploy to the wrong box: the attached adb device must be the same host
# that serves $HOST. Two Decaid installs on one network is a real setup (an older
# dev tablet beside the machine's), and pushing to the wrong one silently does
# nothing visible.
API_IP="$(curl -sf -m 5 "http://$HOST/api/v1/info" | sed -n 's/.*"localIp":"\([^"]*\)".*/\1/p')"
ADB_IPS="$(adb shell ip -4 addr show 2>/dev/null | tr -d '\r' | sed -n 's/.*inet \([0-9.]*\)\/.*/\1/p' | grep -v '^127\.')"
if [ -z "$API_IP" ]; then
  die "cannot read localIp from http://$HOST/api/v1/info"
elif ! printf '%s\n' "$ADB_IPS" | grep -qx "$API_IP"; then
  die "attached adb device ($(printf '%s' "$ADB_IPS" | tr '\n' ' ')) is not $HOST ($API_IP) — refusing to install on the wrong Decaid"
fi
printf 'target: %s (%s), adb device matches\n' "$HOST" "$API_IP"

say "pushing plugin to $PKG"
adb push "$SRC/." "$TMP/" >/dev/null
adb shell run-as "$PKG" mkdir -p "app_flutter/plugins/$ID"
# Two plain copy commands, no nested shell: `sh -c` through adb re-splits the quoting.
adb shell run-as "$PKG" cp "$TMP/manifest.json" "app_flutter/plugins/$ID/manifest.json" \
  || die "copy into app storage failed (is the build debuggable?)"
adb shell run-as "$PKG" cp "$TMP/plugin.js" "app_flutter/plugins/$ID/plugin.js" \
  || die "copy into app storage failed (is the build debuggable?)"
adb shell run-as "$PKG" ls "app_flutter/plugins/$ID" | tr -d '\r' | grep -q plugin.js \
  || die "plugin.js did not land in app storage"

say "restarting Decaid so the plugin scan picks it up"
adb shell am force-stop "$PKG"
adb shell am start -n "$PKG/.MainActivity" >/dev/null

say "waiting for the API on $HOST"
for _ in $(seq 1 60); do
  if curl -sf -m 2 "http://$HOST/api/v1/info" >/dev/null; then break; fi
  sleep 1
done
curl -sf -m 5 "http://$HOST/api/v1/info" >/dev/null || die "API did not come back up"

say "checking that Decaid sees the plugin"
curl -sf -m 5 "http://$HOST/api/v1/plugins" \
  | grep -q "\"id\":\"$ID\"" || die "plugin not listed — check Decaid's logs"

say "enabling + preset=$PRESET"
curl -sf -m 10 -X POST "http://$HOST/api/v1/plugins/$ID/enable" >/dev/null
curl -sf -m 10 -X POST "http://$HOST/api/v1/plugins/$ID/settings" \
  -H 'content-type: application/json' -d "{\"Preset\":\"$PRESET\"}" >/dev/null

say "status"
sleep 2
curl -sf -m 5 "http://$HOST/api/v1/plugins/$ID/status" || die "status endpoint did not answer"
printf '\n\ndeployed %s (preset %s)\n' "$ID" "$PRESET"
