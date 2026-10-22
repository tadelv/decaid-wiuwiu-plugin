#!/usr/bin/env bash
# Live check that the plugin is installed, enabled and actually animating.
#
#   ./scripts/verify.sh
#   DECAID_HOST=de1tablet.home:8080 ./scripts/verify.sh
#
# Exits non-zero if any assertion fails. Read-only: it never writes the machine.
set -euo pipefail

HOST="${DECAID_HOST:-de1tablet.home:8080}"
ID="wiuwiu.reaplugin"
BASE="http://$HOST"

curl -sf -m 5 "$BASE/api/v1/plugins/$ID/status" >/dev/null 2>&1 || {
  printf 'error: status endpoint unavailable — plugin not installed or not loaded\n' >&2
  exit 1
}

python3 - "$BASE" "$ID" <<'PY'
import json, sys, time, urllib.request

base, pid = sys.argv[1], sys.argv[2]

def get(path):
    with urllib.request.urlopen(base + path, timeout=8) as r:
        return json.load(r)

plugins = {p["id"]: p for p in get("/api/v1/plugins")}
entry = plugins.get(pid)
if entry is None:
    sys.exit("FAIL plugin not listed by Decaid")
if not entry.get("loaded"):
    sys.exit("FAIL plugin installed but not loaded")
if not entry.get("autoLoad"):
    sys.exit("FAIL plugin not enabled (autoLoad false)")

first = get(f"/api/v1/plugins/{pid}/status")
time.sleep(4)
second = get(f"/api/v1/plugins/{pid}/status")

print("plugin   :", entry["name"], entry["version"], "loaded=%s autoLoad=%s" % (entry["loaded"], entry["autoLoad"]))
print("preset   :", second["preset"])
print("state    :", second["state"], "/", second["substate"])
print("transport:", second["transport"], "active=%s" % second["active"])

fails = []
if second["preset"] != "rainbow" and "--any-preset" not in sys.argv:
    fails.append("preset is %r, expected 'rainbow'" % second["preset"])
if second["state"] is None:
    fails.append("no machine state observed")
if second["state"] in ("sleeping", "goingToSleep"):
    if second["framesSent"] != first["framesSent"]:
        fails.append("frames advanced while the machine is asleep")
    if second["active"]:
        fails.append("status reports active while the machine is asleep")
    print("frames   : %d (asleep: expected flat)" % second["framesSent"])
else:
    if second["transport"] != "open":
        fails.append("transport is %r, expected 'open'" % second["transport"])
    if second["framesSent"] <= first["framesSent"]:
        fails.append("frame counter did not advance (%d -> %d)" % (first["framesSent"], second["framesSent"]))
    if not second["lastFront"] or not second["lastBack"]:
        fails.append("no last-written colours recorded")
    if second["preset"] in ("rainbow", "breathing") and second["lastFront"] == first["lastFront"]:
        fails.append("colour did not change over 4 s for preset %r" % second["preset"])
    print("frames   : %d -> %d (+%d)" % (first["framesSent"], second["framesSent"], second["framesSent"] - first["framesSent"]))
    print("writes   : %d written, %d deduped, %d skipped frames" % (
        second["writesWritten"], second["writesDeduped"], second["framesSkipped"]))
    print("colour   : front %s -> %s, back %s -> %s" % (
        first["lastFront"], second["lastFront"], first["lastBack"], second["lastBack"]))
    if second["restores"]:
        print("restores : %d" % second["restores"])

if second.get("lastError"):
    print("lastError:", second["lastError"])

if fails:
    print()
    for f in fails:
        print("FAIL", f)
    sys.exit(1)
print("\nOK — plugin %s is installed, enabled and animating (preset %s)" % (pid, second["preset"]))
PY
