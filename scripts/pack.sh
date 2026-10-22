#!/usr/bin/env bash
# Build the installable plugin zip for Decaid's "Install plugin -> From zip".
# The archive holds a single top-level folder containing manifest.json and
# plugin.js, which is what resolvePluginPackage() accepts.
#
#   ./scripts/pack.sh           # build dist/wiuwiu.reaplugin.zip
#   ./scripts/pack.sh --push    # ...and copy it to the tablet's Downloads
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ID="wiuwiu.reaplugin"
HOST="${DECAID_HOST:-de1tablet.home:8080}"
mkdir -p "$ROOT/dist"
rm -f "$ROOT/dist/$ID.zip"
(cd "$ROOT" && zip -qr "dist/$ID.zip" "$ID" -x '*.DS_Store')
unzip -l "$ROOT/dist/$ID.zip"
printf '\nbuilt %s\n' "$ROOT/dist/$ID.zip"

if [ "${1:-}" = "--push" ]; then
  API_IP="$(curl -sf -m 5 "http://$HOST/api/v1/info" | sed -n 's/.*"localIp":"\([^"]*\)".*/\1/p')"
  [ -n "$API_IP" ] || { echo "cannot read localIp from http://$HOST/api/v1/info" >&2; exit 1; }
  for candidate in $(adb devices | awk 'NR>1 && $2=="device"{print $1}'); do
    if adb -s "$candidate" shell ip -4 addr show 2>/dev/null | tr -d '\r' | grep -q "inet $API_IP/"; then
      adb -s "$candidate" push "$ROOT/dist/$ID.zip" "/sdcard/Download/$ID.zip"
      echo "staged on $HOST — on the tablet: Settings -> Plugins -> Install plugin -> From zip -> $ID.zip"
      exit 0
    fi
  done
  echo "no attached adb device owns $API_IP — zip built but not pushed" >&2
  exit 1
fi

echo "push it with: adb push dist/$ID.zip /sdcard/Download/   (or re-run with --push)"
