# Decaid ↔ Bengle LED protocol reference

Everything below was read from `decentespresso/decaid` at `main` (HEAD
`c723a39d`, 2026-10-21) and/or verified against the live instance at
`de1tablet.home:8080` (Bengle, serial 11431, Decaid 0.9.0).

Clone used for reference: `/tmp/decaid` (full history, depth 1 at fetch time).

## 1. What the LED hardware exposes

Bengle has two separately addressed LED registers that are *live* (they light
the strip immediately) and four *stored palette* registers (persisted config):

| Name | MMR address | Bytes | Kind | Purpose |
| --- | --- | --- | --- | --- |
| `frontLedColor` | `0x00803890` | 4 | int32 | live front strip colour (RGB in low 24 bits) |
| `rearLedColor` | `0x00803894` | 4 | int32 | live back strip colour |
| `frontLedAwake` | `0x00803898` | 4 | int32 | stored palette: front, machine awake |
| `rearLedAwake` | `0x0080389C` | 4 | int32 | stored palette: back, machine awake |
| `frontLedSleep` | `0x008038A0` | 4 | int32 | stored palette: front, machine asleep |
| `rearLedSleep` | `0x008038A4` | 4 | int32 | stored palette: back, machine asleep |

Source: `lib/src/models/device/impl/bengle/bengle_mmr.dart`.

There is **no** independent front-switch register. The front panel switch is
lit from the front strip value (`frontSwitch` in the REST palette is derived
from `frontStrip`), so writing `frontLedColor` also moves the switch.

### Colour encoding

The registers carry 8 bits per channel even though the REST palette models 16
bits. Decaid converts with

```dart
((color.red >> 8) << 16) | ((color.green >> 8) << 8) | (color.blue >> 8)
```

so the wire value is `(R << 16) | (G << 8) | B` with `R,G,B` in `0..255`.
(`lib/src/models/device/impl/de1/unified_de1/led_strip_capability.dart`)

### Volatility

* A write to the live registers lights the strip at once.
* The firmware **recomputes the live pair from the stored palette at boot and
  on every sleep/wake transition** (`doc/plans/archive/bengle-led-strip/`
  and `.agents/skills/decent-app/scenarios/bengle-led-strip.md` in the Decaid
  repo). A preview colour therefore survives until the next sleep/wake
  transition — it is never persisted, and nothing else rewrites it in between.
* On firmware before `rheasman/Bengle#114` a preview write still flash-writes
  the live row (wear, not correctness). Unknown which firmware is in the field;
  keep frame rate modest.

## 2. The raw WebSocket

`ws://<decaid-host>:8080/ws/v1/machine/raw`

Bidirectional. Verified live on 2026-10-21/22 against `de1tablet.home:8080`.

### Writing

Request frame:

```json
{"type":"request","operation":"write","characteristicUUID":"A006","payload":"<40 hex chars>"}
```

`payload` is a 20-byte buffer:

| offset | content |
| --- | --- |
| 0 | payload length in bytes (`04`) |
| 1..3 | MMR address, big-endian, low 24 bits (`00 38 90` for `0x00803890`) |
| 4..7 | value, **uint32 little-endian** |
| 8..19 | zero padding |

So `frontLedColor = 0x000030` encodes as `04003890 30 00 00 00` + 16 zero bytes
= `0400389030000000` followed by 32 zeros.

Success response (echo, empty payload):

```json
{"type":"response","operation":"write","characteristicUUID":"A006","payload":""}
```

Source: `lib/src/services/serial/mmr_codec.dart`,
`lib/src/models/device/impl/de1/unified_de1/unified_de1.mmr.dart`,
`unified_de1.raw.dart`, `Endpoint.writeToMMR` (`A006`) in
`de1.models.dart`.

### Reading — not available over the raw socket

An `operation:"read"` frame does **not** issue an MMR read. The raw handler calls
`_transport.read(endpoint)` (a passive characteristic read) and echoes whatever
that returns; it never builds an MMR read request, so no MMR value comes back.

Verified: six `A005` read requests for the LED registers (frames encoded like
the write frame, `payload` = `04` + address + zero padding) timed out with no
`A005` notify, on `0.9.1-beta.1+3012` with a Bengle connected over USB.

The read path that *does* work is REST: `GET /api/v1/machine/ledStrip` returns
the stored palette (16 bits per channel), and `GET /api/v1/machine/state`
returns live pressure/flow/state. The live registers are write-only from a
plugin's point of view.

### Two traps, both verified

1. **`characteristicUUID` is matched exactly, uppercase.** `Endpoint.fromUuid`
   compares the string as given; `"a006"` is silently dropped
   (`Ignoring unknown endpoint`). Send `"A006"` / `"A005"`.
2. **The socket also carries the full notification stream.** On this machine
   the Bengle shot-sample characteristic `A013` notifies continuously (~10 Hz
   idle, faster during a shot). Every raw-socket client must cheaply ignore
   frames whose `operation` is `notify` and whose characteristic is not the one
   it asked for.

Command sent while no machine is attached answers
`{"error":"No machine connected"}` and is **not** queued. The socket itself
stays open across a machine disconnect/reconnect.

## 3. Machine state, as a plugin sees it

Permission `events.machine` delivers `onEvent({name:"stateUpdate", payload})`
where `payload` is `MachineSnapshot.toJson()`
(`lib/src/models/device/machine.dart`, `plugin_manager.dart`):

```json
{
  "timestamp": "2026-10-22T07:03:51.703502",
  "state": {"state": "idle", "substate": "idle"},
  "flow": 0.0, "pressure": 0.06,
  "targetFlow": 4.0, "targetPressure": 0.0,
  "mixTemperature": 27.5, "groupTemperature": 30.7,
  "targetMixTemperature": 70.5, "targetGroupTemperature": 92.0,
  "profileFrame": 1, "steamTemperature": 27
}
```

`state.state` is one of (`MachineState`):

```
booting busy idle schedIdle sleeping heating preheating espresso hotWater flush
steam steamRinse skipStep cleaning descaling calibration selfTest airPurge
needsWater error fwUpgrade
```

`state.substate` adds `preparingForShot preinfusion pouring pouringDone
pausedSteam puffing cleaning*` and `error*` variants.

Snapshots flow continuously on this machine (the shot-sample stream keeps the
subscription alive), but a plugin should still treat them as a hint: also poll
`GET /api/v1/machine/state` (same JSON shape) as a slow heartbeat, because the
wake-up case must work unattended.

`flow` is ml/s, `pressure` is bar.

## 4. REST surface that matters here

| Method + path | Notes |
| --- | --- |
| `GET /api/v1/machine/state` | same shape as the `stateUpdate` payload |
| `GET /api/v1/machine/capabilities` | contains `ledStrip` on Bengle only |
| `GET /api/v1/machine/ledStrip` | stored palette, 16-bit hex per zone/mode |
| `PUT /api/v1/machine/ledStrip` | writes the stored palette (persisted) |
| `POST /api/v1/machine/ledStrip/preview` | **new in PR #801**; live-only preview |
| `POST /api/v1/machine/ledStrip/preview/clear` | **new in PR #801**; restore palette |
| `POST /api/v1/machine/ledStrip/commit` | no-op compatibility endpoint |
| `POST /api/v1/machine/ledStrip/reset` | reload palette from firmware |

Verified on the tablet's previous build (0.9.0, 2026-10-19): `/preview` and
`/preview/clear` return `404 Route not found`, i.e. the preview API is **newer
than that build**. PR #801 (merged 2026-10-21, `c723a39`) is the commit that
added it, which is why the tablet is being upgraded before this plugin is
installed.

The plugin deliberately does **not** use `/preview` for the animation: it writes
the live MMR registers directly over the raw socket (one frame per zone, no REST
round trip, no hydration). Verified on `0.9.1-beta.1+3012`:

* `POST /preview` answers `202` and leaves `GET /ledStrip` byte-identical.
* `POST /preview/clear` answers `202`.

`/preview/clear` is used exactly once per suspension (sleep detected, plugin
unloaded), as the accurate way to hand the live registers back to the stored
palette for the phase the machine is in — the raw socket cannot read the palette
back. If it fails (older build: `404`), the plugin falls back to
`GET /ledStrip` + two raw writes for the current phase, and if that fails too it
does nothing: the firmware recomputes the live pair at the next sleep/wake
transition anyway.

## 5. Plugin runtime facts that shape the design

Source: `doc/Plugins.md`, `lib/src/plugins/plugin_manager.dart`.

* Manifest permissions used here: `log`, `api`, `events.machine`,
  `network.websocket`.
* Outbound sockets go through `host.transport`
  (`open/onEvent/send/close`), text frames only for WebSocket. Limits: 8 live
  transports per plugin generation, 1 MiB pending outbound per transport.
  `send()` resolves when the payload is accepted into the native queue, not when
  the peer receives it.
* There is **no `setInterval`** — only `setTimeout` / `clearTimeout`
  (`plugin_manager.dart` wrapper scope). An animation loop is a self-rescheduling
  `setTimeout`.
* No global `WebSocket`, no `fetch` without the `api` permission, no timers
  without the wrapper scope. Standard JS (`Math`, `JSON`, string/number) is fine.
* Plugin HTTP endpoints are declared in the manifest `api` array and reached at
  `/api/v1/plugins/<plugin id>/<endpoint>`; WebSocket event endpoints at
  `/ws/v1/plugins/<plugin id>/<endpoint>`.
* `onUnload()` runs on unload/reload; transports owned by the generation are
  closed by the host regardless.

## 6. Installing a plugin on the tablet (no public repo needed)

The REST API only installs from GitHub releases/branches, and the plugin scan
runs once at startup (`_scanAvailablePlugins`), so a hand-placed folder needs a
process restart to be seen:

```sh
# plugin folder -> device
adb push wiuwiu.reaplugin/. /data/local/tmp/wiuwiu.reaplugin/
adb shell run-as net.tadel.reaprime mkdir -p app_flutter/plugins/wiuwiu.reaplugin
adb shell run-as net.tadel.reaprime sh -c \
  'cp /data/local/tmp/wiuwiu.reaplugin/* app_flutter/plugins/wiuwiu.reaplugin/'

# restart decaid so the plugin scan sees it, then enable (sets autoLoad)
adb shell am force-stop net.tadel.reaprime
adb shell am start -n net.tadel.reaprime/.MainActivity
curl -X POST http://de1tablet.home:8080/api/v1/plugins/wiuwiu.reaplugin/enable
```

`run-as` needs a debuggable APK, which is why the tablet build is a debug/profile
build signed with `android/app/debug.keystore`, not a release build.
