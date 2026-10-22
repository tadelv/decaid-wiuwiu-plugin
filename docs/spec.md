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

* `id`: `wiuwiu.reaplugin`, `name`: `Wiu Wiu RGB`, `version`: `0.3.0`, `apiVersion`: 1,
  `author`: `Vid`, `license`: `GPL-3.0-or-later`.
* permissions: `log`, `api`, `events.machine`, `network.websocket`.
* settings (every one needs `label` + `description`, `default` where sensible):

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `Preset` | enum `rainbow`, `breathing`, `playthrough` | `rainbow` | active effect |
| `BreathingColor` | string | `#FFD9A8` | breathing colour, hex `#RRGGBB` (warm white) |
| `Brightness` | number | `100` | 5–100, scales every colour |
| `FrameIntervalMs` | number | `80` | 20–1000, animation frame spacing |
| `PlaythroughPressureMax` | number | `10` | bar mapped to full green |
| `PlaythroughFlowMax` | number | `8` | ml/s mapped to full blue |

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
3. **playthrough** — engages only while the machine is doing one of its four jobs:
   `espresso`, `steam`, `flush`, `hotWater`. Every other state disengages it (see
   *Suspension*), so an idle machine keeps its own stored colours.
   * `backStrip` ← pressure, green ramp: `t = clamp(pressure / PlaythroughPressureMax, 0, 1)`,
     `g = 40 + 215·t`, `r = 0`, `b = 90·(1 - t)` (dim teal → bright green; both
     brightness **and** shade move). The widest green travel that still looks like
     green — a narrower band read as almost static on the machine.
   * `frontStrip` ← flow, blue ramp: `t = clamp(flow / PlaythroughFlowMax, 0, 1)`,
     `b = 60 + 195·t`, `r = 0`, `g = 90·(1 - t)` (dark slate → full blue). Starting
     dark rather than mid-blue roughly doubles the visible swing over a shot.
   * `espresso`, `hotWater`, `flush` → the ramps above.
   * `steam` → warm amber `#FF9A3C` breathing, both strips (pressure/flow carry no
     meaning while steaming).
   * Everything else (`idle`, `busy`, `cleaning`, `error`, `steamRinse`, …) → disengaged:
     no frames, and the stored palette is restored once on the transition out.

## Suspension and restore

A preset is suspended — no frames at all, stored palette restored once per transition —
when either:

* the machine is `sleeping` or `goingToSleep` (every preset), or
* the preset is `playthrough` and the current state is not `espresso`, `steam`, `flush`
  or `hotWater`.

While suspended the state heartbeat keeps running, so engagement is immediate when one
of those states comes round. No snapshot at all (`machineState === null`, i.e. the first
poll has not landed yet) also means no frames.
* Restore order: `POST http://localhost:8080/api/v1/machine/ledStrip/preview/clear`
  (`{}` body). On any failure, `GET /api/v1/machine/ledStrip` and raw-write
  `frontLedColor`/`rearLedColor` with the palette colour of the current phase
  (`sleeping ? *.sleeping : *.awake`, high byte of each 16-bit channel). On failure of
  that too, give up silently and log once.
* Wake or re-engage (any animating state) → resume the loop and force the next frame to
  be written (clear the "last written" cache).
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
  payload: "04" + "803890" + <uint32 LE value, 8 hex chars> + "00".repeat(12) }
```

  That is exactly 20 bytes / 40 hex characters, matching the fixed 20-byte buffer
  Decaid itself sends. The address bytes are the 32-bit big-endian address with
  its first byte replaced by the length: `0x00803890` → `803890` for
  `frontLedColor`, `0x00803894` → `803894` for `rearLedColor`. (`00 38 90` is
  address `0x003890`, which is not the LED register — and Decaid echoes a write
  response either way, so an acknowledgement proves nothing about the target.)
* At most one frame in flight: if the previous `send` has not settled, skip this frame and
  count it. Serialise per frame: send front, then back, awaiting each (a rejected send
  marks the transport dead).
* Per-zone de-duplication: remember the last successfully written 24-bit value per register
  and skip a write whose value is unchanged. Force-write right after a resume/restore.

## State source

* `onEvent` with `name === "stateUpdate"` → cache `payload.state.state`,
  `payload.state.substate`, `payload.pressure`, `payload.flow`.
* Newest snapshot wins. Both sources carry the machine's own `timestamp`; a snapshot
  older than the last one applied is ignored, because the REST body can lag the event
  stream and would otherwise un-suspend a machine that is already going to sleep.
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

Endpoint handler: the plugin exports `handleHttpRequest(request)` and returns (or
resolves to) the host envelope, not a bare object:

```js
{
  requestId: request.requestId,
  status: 200,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
  body: JSON.stringify(statusSnapshot())   // string, not an object
}
```

The host passes `body` straight through to `Response(status, body: body)`, so it must be
a string (`plugins_handler.dart` `_handlePluginApiEndpoint`,
`plugin_manager.dart` `__dispatchPluginHttp`; the shipped pattern is
`assets/plugins/settings.reaplugin/plugin.js`). Keep `statusSnapshot()` as an internal
helper and assert on it in tests, plus one test that the envelope's `body` parses back to
the same object and `status === 200`.

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
