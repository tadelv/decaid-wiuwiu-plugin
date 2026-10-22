# Wiu Wiu RGB — behaviour spec (v0.1.0)

A Decaid plugin that animates a Bengle's LED strips from machine state, writing
the live LED registers over the raw machine WebSocket.

Protocol facts, addresses and traps: [`protocol.md`](protocol.md). Read it before
the code.

## Shape

```
wiuwiu.reaplugin/manifest.json
wiuwiu.reaplugin/plugin.js      # defines global function createPlugin(host)
test/plugin.test.mjs            # node --test, no dependencies
package.json                    # { "scripts": { "test": "node --test test/" } }
```

`plugin.js` is a host script, not an ES module: it must define
`function createPlugin(host)` and return `{ id, version, onLoad, onEvent, onUnload }`.
The test loads it with `node:vm` into a bare context and calls `createPlugin(fakeHost)`.
Everything else stays inside that function's closure.

## Manifest

* `id`: `wiuwiu.reaplugin`, `name`: `Wiu Wiu RGB`, `version`: `0.1.0`, `apiVersion`: 1,
  `author`: `tadelv`.
* permissions: `log`, `api`, `events.machine`, `network.websocket`.
* settings (every one needs `label` + `description`, `default` where sensible):

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `Preset` | enum `rainbow`, `breathing`, `playthrough` | `rainbow` | active effect |
| `BreathingColor` | string | `#FFD9A8` | breathing colour, hex `#RRGGBB` (warm white) |
| `Brightness` | number | `100` | 5–100, scales every colour |
| `FrameIntervalMs` | number | `80` | 20–1000, animation frame spacing |
| `PlaythroughPressureMax` | number | `12` | bar mapped to full green |
| `PlaythroughFlowMax` | number | `6` | ml/s mapped to full blue |

Invalid/blank values fall back to the defaults above — never throw from `onLoad`.

* api: one HTTP endpoint `status` (`{"id":"status","type":"http","data":{...}}`)
  served at `/api/v1/plugins/wiuwiu.reaplugin/status`.

## Effects

All colours are `(r,g,b)` bytes, scaled by `Brightness/100`, and sent as
`(r<<16)|(g<<8)|b`.

1. **rainbow** — hue `((now - t0) / RainbowPeriod) * 360 % 360`, `RainbowPeriod = 6000 ms`,
   full saturation/value. All three zones (front strip, back strip, front switch) share
   the colour; the switch follows the front strip automatically.
2. **breathing** — `BreathingColor` with
   `alpha = (1 - cos(2π · t / 4000)) / 2` (0 → 1 → 0 over 4 s), applied to all three zones.
3. **playthrough** — splits the two strips by state:
   * `backStrip` ← pressure, green ramp: `t = clamp(pressure / PlaythroughPressureMax, 0, 1)`,
     `g = 60 + 195·t`, `r = 0`, `b = 90·(1 - t)` (dim blue-green → bright green; both
     brightness **and** shade move).
   * `frontStrip` ← flow, blue ramp: `t = clamp(flow / PlaythroughFlowMax, 0, 1)`,
     `b = 120 + 135·t`, `r = 0`, `g = 60·(1 - t)` (dim indigo → bright blue).
   * `espresso`, `hotWater`, `flush`, `busy`, `skipStep`, `cleaning`, `descaling`,
     `airPurge`, `calibration`, `selfTest` → the ramps above.
   * `steam`, `steamRinse` → warm amber `#FF9A3C` breathing, both strips (pressure/flow
     carry no meaning there).
   * `error` → dim red `#C81E1E` breathing on both strips.
   * `idle`, `schedIdle`, `heating`, `preheating`, `needsWater`, `booting`, unknown →
     soft teal `#1E6E6E` breathing at 25 % brightness on both strips (a "ready" glow,
     so an idle machine is not black).
   * `sleeping`, `goingToSleep` → suspended (see below) for every preset.

## Suspension and restore

* `sleeping` or `goingToSleep` → **no frames at all**. Cancel the frame timer, cancel any
  in-flight retry, and run the restore exactly once per transition into sleep.
* Restore order: `POST http://localhost:8080/api/v1/machine/ledStrip/preview/clear`
  (`{}` body). On any failure, `GET /api/v1/machine/ledStrip` and raw-write
  `frontLedColor`/`rearLedColor` with the palette colour of the current phase
  (`sleeping ? *.sleeping : *.awake`, high byte of each 16-bit channel). On failure of
  that too, give up silently and log once.
* Wake (any non-sleep state) → read the settings again is unnecessary; just resume the
  loop, forcing the next frame to be written (clear the "last written" cache).
* `onUnload()` → stop timers, close the transport, run the same restore once (best effort;
  do not await it in a way that can hang the unload — but do start it).

## Transport

* One WebSocket to `ws://localhost:8080/ws/v1/machine/raw` opened lazily on first need via
  `host.transport.open({kind:"websocket", url}`).
* Register `onEvent` **before** the first `send`. On `{type:"close"}` or `{type:"error"}`:
  mark disconnected, cancel the frame timer, and retry `open` with backoff
  (1 s, 2 s, 5 s, capped at 10 s) — forever, while the machine is awake.
* Inbound frames: parse JSON; ignore anything that is not
  `{operation:"write", characteristicUUID:"A006"}` (the socket also carries the `A013`
  shot-sample notification stream at ~10 Hz and `A005` notes). Count them for `status`.
* Frame format (write, uppercase `A006`):

```js
{ type: "request", operation: "write", characteristicUUID: "A006",
  payload: "04" + "003890" + <uint32 LE value, 8 hex chars> + "00".repeat(8) }
```

  `frontLedColor` = `0x00803890`, `rearLedColor` = `0x00803894`.
* At most one frame in flight: if the previous `send` has not settled, skip this frame and
  count it. Serialise per frame: send front, then back, awaiting each (a rejected send
  marks the transport dead).
* Per-zone de-duplication: remember the last successfully written 24-bit value per register
  and skip a write whose value is unchanged. Force-write right after a resume/restore.

## State source

* `onEvent` with `name === "stateUpdate"` → cache `payload.state.state`,
  `payload.state.substate`, `payload.pressure`, `payload.flow`.
* Seed and heartbeat: `fetch("http://localhost:8080/api/v1/machine/state")` on load and
  every 5000 ms while loaded. A failed poll keeps the last known state and is visible in
  `status.lastError`; it must not stop the animation loop.

## Status endpoint

`GET /api/v1/plugins/wiuwiu.reaplugin/status` returns JSON:

```json
{
  "preset": "rainbow",
  "state": "idle",
  "substate": "idle",
  "active": true,
  "transport": "open",
  "framesSent": 412,
  "framesSkipped": 3,
  "writesWritten": 806,
  "writesDeduped": 17,
  "lastFront": "FF00AA",
  "lastBack": "FF00AA",
  "lastFrameAt": "2026-10-22T07:31:02.114Z",
  "restores": 1,
  "lastError": null,
  "pressure": 0.06,
  "flow": 0.01,
  "uptimeMs": 182341
}
```

Endpoint handler signature is `(body) => ({...})` for an HTTP endpoint (see the
`time-to-ready` bundled plugin for the host shape; return a plain object, the host
serialises it).

## Tests (`test/plugin.test.mjs`, `node --test`)

Fake host: records `log`, `emit`, `storage`, provides `transport` with a scriptable
sink, and a `fetch` that answers the two GETs and the restore POSTs. Drive time with an
injected clock — the plugin must read `Date.now()` through a single indirection the test
can override (e.g. `const now = () => Date.now()` plus a test-only setter on the returned
object). Document the seam in a comment where it is defined.

Required cases:

1. manifest parses; ids/permissions/settings present; `status` endpoint declared.
2. rainbow: frames at t0/t0+1500/t0+3000 differ; all three channels present; hue wraps.
3. breathing: alpha is ~0 at t=0, ~1 at t=2000, ~0 at t=4000; colour is `BreathingColor`.
4. playthrough ramps: pressure 0 vs max increases green and decreases blue; flow 0 vs max
   increases blue and decreases green; idle state gives the teal glow; error gives red;
   steam gives amber.
5. sleeping → zero frames sent, restore called once (POST preview/clear); no restore storm
   on repeated sleeping updates.
6. wake after sleep → first frame written even if it equals the pre-sleep colour.
7. de-duplication: identical consecutive colours produce no second write.
8. frame timer respects `FrameIntervalMs` and never overlaps (slow send → skipped frames).
9. transport close → reconnect attempt scheduled; reopen → frames resume.
10. brightness 50 halves each channel (within rounding).
11. status counters reflect sent/deduped/skipped writes.
