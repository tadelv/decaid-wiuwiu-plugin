#!/usr/bin/env bash
# Build the installable plugin zip for Decaid's "Install plugin -> From zip".
# The archive holds a single top-level folder containing manifest.json and
# plugin.js, which is what resolvePluginPackage() accepts.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ID="wiuwiu.reaplugin"
mkdir -p "$ROOT/dist"
rm -f "$ROOT/dist/$ID.zip"
(cd "$ROOT" && zip -qr "dist/$ID.zip" "$ID" -x '*.DS_Store')
unzip -l "$ROOT/dist/$ID.zip"
printf '\nbuilt %s\n' "$ROOT/dist/$ID.zip"
echo "push it with: adb push dist/$ID.zip /sdcard/Download/"
