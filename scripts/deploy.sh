#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Install / update the Wiu Wiu RGB plugin on a Decaid tablet and enable it.
#
#   ./scripts/deploy.sh                 # push, restart Decaid, enable, preset=rainbow
#   ./scripts/deploy.sh breathing       # same, but select another preset
#   DECAID_HOST=decaid.local:8080 DECAID_PACKAGE=net.tadel.reaprime ./scripts/deploy.sh
#
# Requires: adb with the tablet attached, and a debuggable Decaid build (run-as).
set -euo pipefail

HOST="${DECAID_HOST:-localhost:8080}"
PKG="${DECAID_PACKAGE:-net.tadel.reaprime}"
ID="wiuwiu.reaplugin"
PRESET="${1:-rainbow}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/$ID"
TMP="/data/local/tmp/$ID"

say() { printf '\n== %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ -f "$SRC/manifest.json" ] && [ -f "$SRC/plugin.js" ] || die "plugin files missing in $SRC"
[ "$(adb devices | awk 'NR>1 && $2=="device"' | wc -l | tr -d ' ')" -gt 0 ] || die "no adb device attached"

API_IP="$(curl -sf -m 5 "http://$HOST/api/v1/info" | sed -n 's/.*"localIp":"\([^"]*\)".*/\1/p')"
[ -n "$API_IP" ] || die "cannot read localIp from http://$HOST/api/v1/info"

# Pick the attached device that owns the API's address. More than one Decaid can be
# on the network (an older dev tablet beside the machine's), and pushing to the wrong
# one looks like a successful deploy while changing nothing visible.
adb_ips() { adb -s "$1" shell ip -4 addr show 2>/dev/null | tr -d '\r' | sed -n 's/.*inet \([0-9.]*\)\/.*/\1/p'; }
SERIAL="${DECAID_SERIAL:-}"
if [ -z "$SERIAL" ]; then
  for candidate in $(adb devices | awk 'NR>1 && $2=="device"{print $1}'); do
    if adb_ips "$candidate" | grep -qx "$API_IP"; then SERIAL="$candidate"; break; fi
  done
fi
[ -n "$SERIAL" ] || die "no attached adb device owns $API_IP ($HOST) — refusing to install on the wrong Decaid"
printf 'target: %s (%s), adb device %s\n' "$HOST" "$API_IP" "$SERIAL"
ADB="adb -s $SERIAL"

say "pushing plugin to $PKG"
$ADB push "$SRC/." "$TMP/" >/dev/null
$ADB shell run-as "$PKG" mkdir -p "app_flutter/plugins/$ID"
# Two plain copy commands, no nested shell: `sh -c` through adb re-splits the quoting.
$ADB shell run-as "$PKG" cp "$TMP/manifest.json" "app_flutter/plugins/$ID/manifest.json" \
  || die "copy into app storage failed (is the build debuggable?)"
$ADB shell run-as "$PKG" cp "$TMP/plugin.js" "app_flutter/plugins/$ID/plugin.js" \
  || die "copy into app storage failed (is the build debuggable?)"
$ADB shell run-as "$PKG" ls "app_flutter/plugins/$ID" | tr -d '\r' | grep -q plugin.js \
  || die "plugin.js did not land in app storage"

say "restarting Decaid so the plugin scan picks it up"
$ADB shell am force-stop "$PKG"
$ADB shell am start -n "$PKG/.MainActivity" >/dev/null

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
