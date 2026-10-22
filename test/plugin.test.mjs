// SPDX-License-Identifier: GPL-3.0-or-later
// node --test test/ — no dependencies.
//
// The plugin is a host script, not a module: plugin.js defines a global
// `createPlugin(host)` which is evaluated here in a bare `node:vm` context that
// carries only the globals the host provides (setTimeout, clearTimeout, fetch;
// JSON/Math/Date/Number/String/Error/Promise are the context's own intrinsics).
// There is deliberately no setInterval in that context.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = path.join(ROOT, "wiuwiu.reaplugin");
const MANIFEST_PATH = path.join(PLUGIN_DIR, "manifest.json");
const PLUGIN_PATH = path.join(PLUGIN_DIR, "plugin.js");

const PLUGIN_ID = "wiuwiu.reaplugin";
const STATE_URL = "http://localhost:8080/api/v1/machine/state";
const LEDSTRIP_URL = "http://localhost:8080/api/v1/machine/ledStrip";
const CLEAR_URL = "http://localhost:8080/api/v1/machine/ledStrip/preview/clear";

// MMR addresses, from lib/src/models/device/impl/bengle/bengle_mmr.dart:
//   frontLedColor 0x00803890, rearLedColor 0x00803894
const FRONT_MMR = 0x00803890;
const BACK_MMR = 0x00803894;

// The on-wire address field is the 32-bit big-endian address with its first byte
// replaced by the payload length, so the three bytes kept are the low 24 bits
// (`0x00803890` -> `80 38 90`). Deriving them from the numeric address keeps this
// assertion from drifting with the implementation, which is how a wrong
// `00 38 90` (address 0x003890) survived an earlier review.
const wireAddr = (mmr) => (mmr & 0xffffff).toString(16).padStart(6, "0").toUpperCase();

const FRONT_ADDR = wireAddr(FRONT_MMR); // "803890"
const BACK_ADDR = wireAddr(BACK_MMR); // "803894"

// Fixed epoch so every expected timestamp is deterministic.
const T0 = Date.UTC(2026, 9, 22, 7, 30, 0);

// ── fake clock ────────────────────────────────────────────────────────────────
// Drives the host timers the plugin gets as globals, and provides the value the
// plugin reads through its clock seam (plugin.__setNow).
function createClock(start) {
  let current = start;
  let nextId = 1;
  let seq = 0;
  const timers = new Map();

  const api = {
    now: () => current,
    setTimeout(fn, delay) {
      const id = nextId++;
      const d = Number.isFinite(delay) ? Math.max(0, delay) : 0;
      timers.set(id, { at: current + d, seq: seq++, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async flush() {
      // Let the plugin's promise chains (open → onEvent → send → status) settle.
      for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
    },
    async advance(ms) {
      const target = current + ms;
      await api.flush();
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          if (t.at > target) continue;
          if (!next || t.at < next.t.at || (t.at === next.t.at && t.seq < next.t.seq)) {
            next = { id, t };
          }
        }
        if (!next) break;
        timers.delete(next.id);
        if (next.t.at > current) current = next.t.at;
        next.t.fn();
        await api.flush();
      }
      current = target;
      await api.flush();
    },
    pending: () => timers.size,
  };
  return api;
}

// ── fake host transport ───────────────────────────────────────────────────────
// Shapes follow doc/Plugins.md §Network Transports: open() resolves
// {handle, protocol}, onEvent(handle, cb) registers one listener, send(handle,
// {type:"text", data}) returns a promise, close(handle) releases the handle.
function createTransport() {
  const t = {
    opens: [],
    handles: new Map(),
    sent: [], // { handle, request, payload }
    closed: [],
    failOpens: 0,
    deferOpens: false,
    pendingOpens: [],
    deferSends: false,
    pendingSends: [],
    open(options) {
      t.opens.push(options);
      if (t.failOpens > 0) {
        t.failOpens -= 1;
        return Promise.reject(new Error("connect ECONNREFUSED"));
      }
      const handle = `h${t.opens.length}`;
      if (t.deferOpens) return new Promise((resolve) => t.pendingOpens.push(() => resolve({ handle })));
      return Promise.resolve({ handle });
    },
    onEvent(handle, cb) {
      assert.equal(typeof cb, "function", "transport.onEvent needs a callback");
      t.handles.set(handle, cb);
    },
    send(handle, payload) {
      assert.equal(typeof payload, "object");
      assert.equal(payload.type, "text", "WebSocket frames are text");
      assert.equal(typeof payload.data, "string");
      t.sent.push({ handle, request: JSON.parse(payload.data), payload: payload.data });
      if (t.deferSends) return new Promise((resolve) => t.pendingSends.push(resolve));
      return Promise.resolve();
    },
    close(handle) {
      t.closed.push(handle);
      t.handles.delete(handle);
      return Promise.resolve();
    },
    // push one event into the plugin's registered listener
    emit(handle, event) {
      const cb = t.handles.get(handle);
      assert.equal(typeof cb, "function", `no listener registered for ${handle}`);
      cb(event);
    },
    release() {
      const pending = t.pendingSends;
      t.pendingSends = [];
      for (const resolve of pending) resolve();
    },
    releaseOpen() {
      const pending = t.pendingOpens;
      t.pendingOpens = [];
      for (const resolve of pending) resolve();
    },
  };
  return t;
}

function httpResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

// ── fake fetch ────────────────────────────────────────────────────────────────
function createFetch() {
  const f = {
    calls: [],
    state: { state: { state: "idle", substate: "idle" }, pressure: 0.06, flow: 0.01 },
    stateFails: false,
    clearStatus: 202,
    ledStripStatus: 200,
    // GET /api/v1/machine/ledStrip — Color16.toJson() is a 12-char RRRRGGGGBBBB
    // hex string per channel triple (lib/src/models/device/led_strip.dart:16).
    palette: {
      frontStrip: { awake: "FFFFD9D9A8A8", sleeping: "FF0000000000" },
      backStrip: { awake: "0000FFFF0000", sleeping: "0000FF000000" },
      frontSwitch: { awake: "FFF0F0C8C8", sleeping: "5550504343" },
    },
    fn(url, init) {
      const method = (init && init.method) || "GET";
      f.calls.push({ url, method, body: init && init.body });
      if (method === "POST" && url === CLEAR_URL) {
        return Promise.resolve(httpResponse(f.clearStatus, "{}"));
      }
      if (method === "GET" && url === STATE_URL) {
        if (f.stateFails) return Promise.reject(new Error("state poll boom"));
        return Promise.resolve(httpResponse(200, JSON.stringify(f.state)));
      }
      if (method === "GET" && url === LEDSTRIP_URL) {
        return Promise.resolve(httpResponse(f.ledStripStatus, JSON.stringify(f.palette)));
      }
      return Promise.resolve(httpResponse(404, JSON.stringify({ error: "Route not found" })));
    },
    count(method, url) {
      return f.calls.filter((c) => c.method === method && (!url || c.url === url)).length;
    },
  };
  return f;
}

// ── harness ───────────────────────────────────────────────────────────────────
function loadPlugin(options = {}) {
  const source = fs.readFileSync(PLUGIN_PATH, "utf8");
  const clock = options.clock || createClock(T0);
  const transport = options.transport || createTransport();
  const fetchApi = options.fetchApi || createFetch();
  const logs = [];

  const host = {
    log: (message) => logs.push(String(message)),
    emit: () => {},
    storage: () => {},
    transport,
  };

  const context = vm.createContext({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    fetch: fetchApi.fn,
  });

  vm.runInContext(source, context, { filename: PLUGIN_PATH });
  assert.equal(typeof context.createPlugin, "function", "plugin.js must define global createPlugin");

  const plugin = context.createPlugin(host);
  // test-only clock seam documented in plugin.js
  assert.equal(typeof plugin.__setNow, "function", "plugin must expose __setNow for the test clock");
  plugin.__setNow(() => clock.now());
  assert.equal(typeof plugin.onLoad, "function");
  plugin.onLoad(options.settings === undefined ? {} : options.settings);

  return { plugin, clock, transport, fetchApi, logs, context };
}

// Emit a machine snapshot and keep the fake /api/v1/machine/state poll in sync.
// The plugin's heartbeat is as authoritative as an event, so a test that leaves
// them disagreeing would race the two state sources.
function emitState(plugin, fetchApi, state, pressure = 0, flow = 0, substate = state) {
  const payload = { state: { state, substate }, pressure, flow };
  fetchApi.state = payload;
  plugin.onEvent({ name: "stateUpdate", payload });
  return payload;
}

function status(plugin) {
  const envelope = plugin.handleHttpRequest({
    requestId: "req-1",
    endpoint: "status",
    method: "GET",
    headers: {},
    body: null,
    query: {},
  });
  assert.equal(envelope.status, 200, "status endpoint answers 200");
  assert.equal(typeof envelope.body, "string", "status body must be a JSON string (shelf Response)");
  return JSON.parse(envelope.body);
}

// Write frames, decoded from the protocol payload:
//   "04" + addr(6) + uint32 LE value(8) + 12 zero bytes = 40 hex chars.
function decodeWrites(transport) {
  return transport.sent.map(({ handle, request }) => ({
    handle,
    request,
    payload: request.payload,
    addr: request.payload.slice(2, 8),
    value: littleEndianValue(request.payload),
  }));
}

function littleEndianValue(payload) {
  const hex = payload.slice(8, 16);
  const bytes = [0, 2, 4, 6].map((i) => Number("0x" + hex.slice(i, i + 2)));
  return ((bytes[3] << 24) | (bytes[2] << 16) | (bytes[1] << 8) | bytes[0]) >>> 0;
}

function fronts(transport) {
  return decodeWrites(transport).filter((w) => w.addr === FRONT_ADDR).map((w) => w.value);
}

function backs(transport) {
  return decodeWrites(transport).filter((w) => w.addr === BACK_ADDR).map((w) => w.value);
}

function channels(value) {
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function hex24(value) {
  return value.toString(16).toUpperCase().padStart(6, "0");
}

function assertChannels(actual, expected, label, tolerance = 1) {
  const have = channels(actual);
  assert.ok(
    have.every((c, i) => Math.abs(c - expected[i]) <= tolerance),
    `${label}: got ${hex24(actual)} ${JSON.stringify(have)}, expected ~${JSON.stringify(expected)}`,
  );
}

// Every channel of a breathing frame is the same source colour scaled by one
// shared factor (alpha × brightness), so the hue ratio must survive scaling.
function assertScaledFrom(actual, base, label) {
  const have = channels(actual);
  for (let i = 0; i <= 1000; i += 1) {
    const s = i / 1000;
    if (have.every((c, idx) => Math.abs(c - Math.round(base[idx] * s)) <= 1)) return s;
  }
  assert.fail(`${label}: ${hex24(actual)} is not a scaled version of ${JSON.stringify(base)}`);
}

// ── 1. manifest + module shape ────────────────────────────────────────────────
test("1. manifest parses, declares ids/permissions/settings and the status endpoint", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));

  assert.equal(manifest.id, PLUGIN_ID);
  assert.equal(manifest.name, "Wiu Wiu RGB");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "manifest carries a semver version");
  // The version the plugin reports must be the manifest's, or status/update checks lie.
  assert.equal(loadPlugin({}).plugin.version, manifest.version, "manifest and plugin versions agree");
  assert.equal(manifest.apiVersion, 1);
  assert.equal(typeof manifest.author, "string");
  assert.ok(manifest.author.length > 0, "manifest declares an author");
  assert.equal(manifest.license, "GPL-3.0-or-later", "manifest declares the licence");

  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["api", "events.machine", "log", "network.websocket"].sort(),
    "permissions are exactly log, api, events.machine, network.websocket",
  );

  const expectedSettings = {
    Preset: "enum",
    BreathingColor: "string",
    Brightness: "number",
    FrameIntervalMs: "number",
    PlaythroughPressureMax: "number",
    PlaythroughFlowMax: "number",
  };
  assert.deepEqual(Object.keys(manifest.settings).sort(), Object.keys(expectedSettings).sort());
  for (const [key, type] of Object.entries(expectedSettings)) {
    const setting = manifest.settings[key];
    assert.equal(setting.type, type, `${key} is a ${type}`);
    assert.equal(typeof setting.label, "string", `${key} needs a label`);
    assert.ok(setting.label.length > 0, `${key} label is not empty`);
    assert.equal(typeof setting.description, "string", `${key} needs a description`);
    assert.ok(setting.description.length > 0, `${key} description is not empty`);
  }

  assert.deepEqual(manifest.settings.Preset.values, ["rainbow", "breathing", "playthrough"]);
  assert.equal(manifest.settings.Preset.default, "rainbow");
  assert.equal(manifest.settings.BreathingColor.default, "#FFD9A8");
  assert.equal(manifest.settings.Brightness.default, 100);
  assert.equal(manifest.settings.FrameIntervalMs.default, 80);
  assert.equal(manifest.settings.PlaythroughPressureMax.default, 10);
  assert.equal(manifest.settings.PlaythroughFlowMax.default, 8);

  const statusEndpoint = manifest.api.find((e) => e.id === "status");
  assert.ok(statusEndpoint, "manifest declares the status endpoint");
  assert.equal(statusEndpoint.type, "http");

  // module shape / bare-vm loadability
  const { plugin, context } = loadPlugin();
  assert.equal(plugin.id, PLUGIN_ID);
  assert.equal(plugin.version, manifest.version, "plugin version matches the manifest");
  for (const member of ["onLoad", "onEvent", "onUnload"]) {
    assert.equal(typeof plugin[member], "function", `plugin exposes ${member}`);
  }
  assert.equal(
    vm.runInContext("[typeof setInterval, typeof require, typeof WebSocket].join()", context),
    "undefined,undefined,undefined",
    "the plugin must not rely on setInterval/require/WebSocket",
  );
});

// ── criterion 2. raw frame format ─────────────────────────────────────────────
test("criterion 2: raw write frames are 20-byte payloads with uppercase A006", async () => {
  const transport = createTransport();
  const fetchApi = createFetch();
  fetchApi.state = { state: { state: "espresso", substate: "pouring" }, pressure: 0, flow: 0 };
  const clock = createClock(T0);
  const { plugin } = loadPlugin({
    clock,
    transport,
    fetchApi,
    settings: { Preset: "playthrough", FrameIntervalMs: 100 },
  });

  plugin.onEvent({
    name: "stateUpdate",
    payload: { state: { state: "espresso", substate: "pouring" }, pressure: 0, flow: 0 },
  });
  await clock.advance(0);

  const writes = decodeWrites(transport);
  assert.equal(writes.length, 2, "one frame = one write per live register");

  const [front, back] = writes;
  assert.equal(front.addr, FRONT_ADDR);
  assert.equal(back.addr, BACK_ADDR);

  // pressure 0 / flow 0, defaults 10 bar / 8 ml/s: back = (0, 40, 90) = 0x00285A,
  // front = (0, 90, 60) = 0x005A3C
  assert.equal(front.value, 0x005a3c);
  assert.equal(back.value, 0x00285a);
  assert.equal(front.payload, "04" + FRONT_ADDR + "3C5A0000" + "0".repeat(24));
  assert.equal(back.payload, "04" + BACK_ADDR + "5A280000" + "0".repeat(24));
  assert.equal(FRONT_ADDR, "803890", "frontLedColor 0x00803890 -> 80 38 90", );
  assert.equal(BACK_ADDR, "803894", "rearLedColor 0x00803894 -> 80 38 94");
  assert.equal(front.payload.length, 40, "payload is 20 bytes / 40 hex chars");
  assert.equal(front.payload.slice(16), "0".repeat(24), "12 zero bytes of padding");

  for (const { request } of writes) {
    assert.equal(request.type, "request");
    assert.equal(request.operation, "write");
    assert.equal(request.characteristicUUID, "A006", "uppercase A006 — lowercase is silently dropped");
  }

  assert.equal(transport.opens.length, 1);
  assert.equal(transport.opens[0].kind, "websocket");
  assert.equal(transport.opens[0].url, "ws://localhost:8080/ws/v1/machine/raw");
  assert.equal(transport.handles.size, 1, "listener registered before the first send");
});

// ── 2. rainbow ────────────────────────────────────────────────────────────────
test("2. rainbow animates, spans all three channels and wraps every 6 s", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const { plugin } = loadPlugin({
    clock,
    transport,
    settings: { Preset: "rainbow", FrameIntervalMs: 100 },
  });
  assert.equal(status(plugin).preset, "rainbow");

  await clock.advance(0); // frame at t0
  const atT0 = fronts(transport).at(-1);
  assertChannels(atT0, [255, 0, 0], "rainbow hue 0 is red");

  await clock.advance(1500);
  const at1500 = fronts(transport).at(-1);
  assertChannels(at1500, [128, 255, 0], "rainbow hue 90");
  // all three zones share the colour: the back strip frame matches the front (switch follows front)
  assert.equal(backs(transport).at(-1), at1500, "back strip mirrors the front strip");

  await clock.advance(1500);
  const at3000 = fronts(transport).at(-1);
  assertChannels(at3000, [0, 255, 255], "rainbow hue 180");

  assert.notEqual(atT0, at1500, "frames 1.5 s apart differ");
  assert.notEqual(at1500, at3000, "frames 3 s apart differ");

  // all three channels appear across the run
  const seen = [...fronts(transport), ...backs(transport)].flatMap(channels);
  assert.ok(seen.some((c) => c > 0), "red channel present");
  const perChannel = [0, 1, 2].map((i) =>
    [...fronts(transport), ...backs(transport)].some((v) => channels(v)[i] > 0),
  );
  assert.deepEqual(perChannel, [true, true, true], "R, G and B all appear");

  await clock.advance(2900); // t0 + 5900
  await clock.advance(100); // t0 + 6000 — hue wraps to 0
  assert.equal(fronts(transport).at(-1), atT0, "hue wraps: 6 s later the colour repeats");
});

// ── 3. breathing ──────────────────────────────────────────────────────────────
test("3. breathing peaks at t=2000 and is dark at t=0 and t=4000 with BreathingColor", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  loadPlugin({
    clock,
    transport,
    settings: { Preset: "breathing", BreathingColor: "#FFD9A8", FrameIntervalMs: 100 },
  });

  await clock.advance(0);
  assertChannels(fronts(transport).at(-1), [0, 0, 0], "alpha ~0 at t=0");
  assertChannels(backs(transport).at(-1), [0, 0, 0], "alpha ~0 at t=0 (back)");

  await clock.advance(2000);
  assertChannels(fronts(transport).at(-1), [255, 217, 168], "alpha ~1 at t=2000 = BreathingColor");
  assertChannels(backs(transport).at(-1), [255, 217, 168], "alpha ~1 at t=2000 (back)");

  await clock.advance(1000);
  const mid = fronts(transport).at(-1);
  assert.ok(channels(mid)[0] > 0 && channels(mid)[0] < 255, "mid-cycle is partially lit");
  assertScaledFrom(mid, [255, 217, 168], "mid-cycle");

  await clock.advance(1000);
  assertChannels(fronts(transport).at(-1), [0, 0, 0], "alpha ~0 at t=4000, cycle restarts");
});

// ── 4. playthrough ────────────────────────────────────────────────────────────
test("4. playthrough engages only for espresso, steam, flush and hotWater", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const fetchApi = createFetch();
  fetchApi.state = { state: { state: "espresso", substate: "pouring" }, pressure: 0, flow: 0 };
  const { plugin } = loadPlugin({
    clock,
    transport,
    fetchApi,
    settings: {
      Preset: "playthrough",
      FrameIntervalMs: 100,
      PlaythroughPressureMax: 10,
      PlaythroughFlowMax: 8,
    },
  });

  // espresso at zero pressure/flow: the two ramps
  emitState(plugin, fetchApi, "espresso", 0, 0);
  await clock.advance(100);
  assertChannels(backs(transport).at(-1), [0, 40, 90], "pressure 0: dim teal");
  assertChannels(fronts(transport).at(-1), [0, 90, 60], "flow 0: dark slate");
  const backZero = backs(transport).at(-1);
  const frontZero = fronts(transport).at(-1);

  // at max
  emitState(plugin, fetchApi, "espresso", 10, 8);
  await clock.advance(100);
  const backMax = backs(transport).at(-1);
  const frontMax = fronts(transport).at(-1);
  assertChannels(backMax, [0, 255, 0], "pressure max: bright green");
  assertChannels(frontMax, [0, 0, 255], "flow max: bright blue");
  assert.ok(channels(backMax)[1] > channels(backZero)[1], "green rises with pressure");
  assert.ok(channels(backMax)[2] < channels(backZero)[2], "blue falls with pressure");
  assert.ok(channels(frontMax)[2] > channels(frontZero)[2], "blue rises with flow");
  assert.ok(channels(frontMax)[1] < channels(frontZero)[1], "green falls with flow");

  // the other two jobs engage with the same ramps
  for (const state of ["hotWater", "flush"]) {
    emitState(plugin, fetchApi, state, 10, 8);
    await clock.advance(100);
    assertChannels(backs(transport).at(-1), [0, 255, 0], `${state} uses the pressure ramp`);
    assertChannels(fronts(transport).at(-1), [0, 0, 255], `${state} uses the flow ramp`);
  }

  // steam → warm amber breathing on both strips (pressure/flow carry no meaning)
  emitState(plugin, fetchApi, "steam", 10, 8);
  await clock.advance(100);
  assertScaledFrom(fronts(transport).at(-1), [255, 154, 60], "steam amber");
  assert.equal(backs(transport).at(-1), fronts(transport).at(-1), "amber on both strips");

  // leaving the four disengages: no more frames, palette handed back once
  const painted = transport.sent.length;
  emitState(plugin, fetchApi, "idle", 0, 0);
  await clock.advance(500);
  assert.equal(transport.sent.length, painted, "no writes once disengaged");
  assert.equal(status(plugin).active, false, "status reports inactive");
  assert.equal(status(plugin).restores, 1, "hands the strips back once");
  assert.equal(fetchApi.count("POST", CLEAR_URL), 1, "via preview/clear");

  // every other state stays disengaged, and repeated non-engaging states do not
  // restore again (no storm)
  for (const state of [
    "busy", "skipStep", "cleaning", "descaling", "airPurge", "calibration", "selfTest",
    "error", "steamRinse", "schedIdle", "heating", "preheating", "needsWater", "booting", "wat",
  ]) {
    emitState(plugin, fetchApi, state, 10, 8);
    await clock.advance(200);
    assert.equal(transport.sent.length, painted, `${state} does not engage playthrough`);
    assert.equal(status(plugin).active, false, `${state} leaves it disengaged`);
  }
  assert.equal(status(plugin).restores, 1, "no restore storm while disengaged");

  // re-engaging resumes immediately and force-writes
  emitState(plugin, fetchApi, "espresso", 10, 8);
  await clock.advance(100);
  assert.ok(transport.sent.length > painted, "frames resume on re-engagement");
  assert.equal(status(plugin).active, true);
  assert.equal(status(plugin).restores, 1, "no extra restore on re-engagement");
});

test("5. sleeping sends no frames and restores exactly once per transition", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const fetchApi = createFetch();
  const { plugin } = loadPlugin({ clock, transport, fetchApi, settings: { FrameIntervalMs: 100 } });

  await clock.advance(300);
  const writesBefore = transport.sent.length;
  assert.ok(writesBefore > 0, "the loop is running before sleep");

  plugin.onEvent({ name: "stateUpdate", payload: { state: { state: "sleeping", substate: "sleeping" } } });
  await clock.flush();

  let snapshot = status(plugin);
  assert.equal(snapshot.active, false, "suspended");
  assert.equal(snapshot.restores, 1, "restore ran once");
  assert.equal(fetchApi.count("POST", CLEAR_URL), 1, "preview/clear posted once");

  const body = fetchApi.calls.find((c) => c.method === "POST" && c.url === CLEAR_URL).body;
  assert.equal(body, "{}", "preview/clear body is {}");

  // repeated sleeping updates (event + heartbeat) must not storm the restore
  fetchApi.state.state.state = "sleeping";
  for (let i = 0; i < 3; i += 1) {
    plugin.onEvent({ name: "stateUpdate", payload: { state: { state: "sleeping", substate: "sleeping" } } });
  }
  await clock.advance(1000);
  assert.equal(transport.sent.length, writesBefore, "no frames while sleeping");
  snapshot = status(plugin);
  assert.equal(snapshot.restores, 1, "no restore storm on repeated sleeping updates");
  assert.equal(fetchApi.count("POST", CLEAR_URL), 1);

  // goingToSleep is also a sleep transition, also frame-free
  const sleepingFetch = createFetch();
  sleepingFetch.state.state.state = "goingToSleep";
  const other = loadPlugin({ clock: createClock(T0), fetchApi: sleepingFetch });
  other.plugin.onEvent({ name: "stateUpdate", payload: { state: { state: "goingToSleep", substate: "x" } } });
  await other.clock.advance(1000);
  assert.equal(other.transport.sent.length, 0, "goingToSleep sends no frames");
  assert.equal(sleepingFetch.count("POST", CLEAR_URL), 1);
});

// ── 6. wake ───────────────────────────────────────────────────────────────────
test("6. waking resumes the loop and force-writes the next frame", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const fetchApi = createFetch();
  const { plugin } = loadPlugin({
    clock,
    transport,
    fetchApi,
    settings: { Preset: "rainbow", FrameIntervalMs: 100 },
  });

  await clock.advance(0);
  const preSleep = fronts(transport).at(-1);
  assertChannels(preSleep, [255, 0, 0], "t=0 frame is rainbow hue 0");

  plugin.onEvent({ name: "stateUpdate", payload: { state: { state: "sleeping", substate: "sleeping" } } });
  fetchApi.state.state.state = "sleeping";
  await clock.flush();
  const duringSleep = transport.sent.length;

  // 6 s later the rainbow hue wraps back to exactly the pre-sleep colour
  await clock.advance(6000);
  assert.equal(transport.sent.length, duringSleep, "still no frames while asleep");

  fetchApi.state.state.state = "idle";
  plugin.onEvent({ name: "stateUpdate", payload: { state: { state: "idle", substate: "idle" } } });
  await clock.advance(0);

  const resumed = transport.sent.length;
  assert.ok(resumed > duringSleep, "frames resume after wake");
  assert.equal(fronts(transport).at(-1), preSleep, "the forced frame carries the same colour");
  const snapshot = status(plugin);
  assert.equal(snapshot.active, true);
  assert.ok(snapshot.framesSent > 0, "the loop is counting frames again");
});

// ── 7. de-duplication ────────────────────────────────────────────────────────
test("7. identical consecutive colours are not written twice", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const fetchApi = createFetch();
  fetchApi.state = { state: { state: "espresso", substate: "pouring" }, pressure: 3, flow: 1 };
  const { plugin } = loadPlugin({
    clock,
    transport,
    fetchApi,
    settings: { Preset: "playthrough", FrameIntervalMs: 100 },
  });
  emitState(plugin, fetchApi, "espresso", 3, 1, "pouring");

  // two frames settle the colour (the first frame can still land on the pre-poll
  // ready glow), then the colour is constant
  await clock.advance(100);
  const settled = transport.sent.length;
  assert.ok(settled > 0);

  await clock.advance(200); // frames at 200 and 300 carry the same colour
  assert.equal(transport.sent.length, settled, "identical consecutive colours are not written again");

  const snapshot = status(plugin);
  assert.equal(snapshot.framesSent, 4, "four frames ran");
  assert.equal(snapshot.writesWritten, settled, "writesWritten tracks the real writes");
  assert.equal(snapshot.writesDeduped, 8 - settled, "the remainder were deduped");
  assert.equal(snapshot.lastFront, hex24(fronts(transport).at(-1)));
  assert.equal(snapshot.lastBack, hex24(backs(transport).at(-1)));
});

// ── 8. frame pacing ──────────────────────────────────────────────────────────
test("8. the loop honours FrameIntervalMs and skips frames instead of queueing", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const { plugin } = loadPlugin({ clock, transport, settings: { FrameIntervalMs: 100 } });

  transport.deferSends = true;
  await clock.advance(0);
  assert.equal(transport.sent.length, 1, "front write in flight");

  await clock.advance(500); // ticks at 100..500 arrive while the send is unsettled
  assert.equal(transport.sent.length, 1, "a slow send must not queue frames");
  let snapshot = status(plugin);
  assert.equal(snapshot.framesSkipped, 5, "five ticks skipped");
  assert.equal(snapshot.framesSent, 0, "no frame completed yet");

  transport.deferSends = false;
  transport.release();
  await clock.flush();
  transport.release();
  await clock.flush();
  snapshot = status(plugin);
  assert.equal(snapshot.framesSent, 1, "the in-flight frame completes once the send settles");

  await clock.advance(300); // ticks at 700, 800, 900
  snapshot = status(plugin);
  assert.equal(snapshot.framesSent, 4, "one frame per interval, no overlap");
  assert.equal(transport.sent.length, 8, "two register writes per frame");
});

// ── 9. reconnection ─────────────────────────────────────────────────────────
test("9. transport close triggers a backoff reopen and frames resume", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const { plugin } = loadPlugin({ clock, transport, settings: { FrameIntervalMs: 100 } });

  await clock.advance(100);
  assert.equal(transport.opens.length, 1);
  assert.equal(status(plugin).transport, "open");

  transport.emit("h1", { type: "close", code: 1006, reason: "peer gone" });
  await clock.flush();
  assert.equal(status(plugin).transport, "closed");

  await clock.advance(900);
  assert.equal(transport.opens.length, 1, "first retry waits 1 s");

  await clock.advance(200);
  assert.equal(transport.opens.length, 2, "reopen after the 1 s backoff");
  assert.equal(status(plugin).transport, "open");

  const before = transport.sent.length;
  await clock.advance(200);
  assert.ok(transport.sent.length > before, "frames resume without a plugin reload");
  assert.equal(transport.sent.at(-1).handle, "h2", "writes use the reopened handle");

  // a failed open also backs off and retries (2 s, then 5 s, then 10 s cap)
  transport.failOpens = 1;
  transport.emit("h2", { type: "error", code: "transport_error", message: "boom" });
  await clock.flush();
  await clock.advance(1000);
  assert.equal(transport.opens.length, 3, "retry 1 s after the error (this open fails)");
  await clock.advance(2000);
  assert.equal(transport.opens.length, 4, "a failed open waits 2 s before the next retry");
});

// ── 10. brightness ──────────────────────────────────────────────────────────
test("10. brightness 50 halves every channel", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const { plugin } = loadPlugin({
    clock,
    transport,
    settings: { Preset: "breathing", BreathingColor: "#FFD9A8", Brightness: 50, FrameIntervalMs: 100 },
  });
  assert.equal(status(plugin).preset, "breathing");

  await clock.advance(2000);
  const half = fronts(transport).at(-1);
  assertChannels(half, [128, 109, 84], "half of #FFD9A8");
  for (const [i, base] of [255, 217, 168].entries()) {
    assert.ok(Math.abs(channels(half)[i] - Math.round(base * 0.5)) <= 1, "within rounding");
  }
});

// ── 11. status counters ─────────────────────────────────────────────────────
test("11. the status endpoint reports live counters in the documented shape", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const fetchApi = createFetch();
  fetchApi.state = { state: { state: "espresso", substate: "pouring" }, pressure: 0, flow: 0 };
  const { plugin } = loadPlugin({
    clock,
    transport,
    fetchApi,
    settings: { Preset: "playthrough", FrameIntervalMs: 100 },
  });
  plugin.onEvent({
    name: "stateUpdate",
    payload: { state: { state: "espresso", substate: "pouring" }, pressure: 0, flow: 0 },
  });

  await clock.advance(300); // four frames, constant colour

  const envelope = plugin.handleHttpRequest({
    requestId: "req-11",
    endpoint: "status",
    method: "GET",
    headers: {},
    body: null,
    query: {},
  });
  assert.equal(envelope.requestId, "req-11", "response carries the request id");
  assert.equal(envelope.status, 200);
  assert.equal(envelope.headers["Content-Type"], "application/json");
  assert.equal(envelope.headers["Cache-Control"], "no-cache");
  assert.equal(typeof envelope.body, "string", "the host passes body straight to shelf Response");

  let snapshot = JSON.parse(envelope.body);
  assert.equal(snapshot.preset, "playthrough");
  assert.equal(snapshot.state, "espresso");
  assert.equal(snapshot.substate, "pouring");
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.transport, "open");
  assert.equal(snapshot.framesSent, 4);
  assert.equal(snapshot.framesSkipped, 0);
  assert.equal(snapshot.writesWritten, 2);
  assert.equal(snapshot.writesDeduped, 6);
  assert.equal(snapshot.lastFront, "005A3C");
  assert.equal(snapshot.lastBack, "00285A");
  assert.equal(snapshot.lastFrameAt, new Date(T0 + 300).toISOString());
  assert.equal(snapshot.restores, 0);
  assert.equal(snapshot.lastError, null);
  assert.equal(snapshot.pressure, 0);
  assert.equal(snapshot.flow, 0);
  assert.equal(snapshot.uptimeMs, 300);

  // the counters move with the live traffic the spec documents
  emitState(plugin, fetchApi, "espresso", 6, 3, "pouring"); // a new colour each frame
  transport.deferSends = true;
  await clock.advance(200); // tick 400 starts a frame, tick 500 skips it
  snapshot = status(plugin);
  assert.equal(snapshot.writesWritten, 2, "a send still in flight is not counted as written");
  assert.equal(transport.sent.length, 3, "the new write is in flight, nothing queued");
  assert.equal(snapshot.framesSkipped, 1);

  // inbound A013 notifications are ignored but counted
  transport.emit("h1", {
    type: "data",
    dataType: "text",
    data: JSON.stringify({ type: "notify", operation: "notify", characteristicUUID: "A013", payload: "AA" }),
  });
  transport.emit("h1", { type: "data", dataType: "text", data: "not json" });
  snapshot = status(plugin);
  assert.equal(snapshot.framesIgnored, 2, "notify frames are ignored, not routed into the animation");
});

// ── criterion 3. heartbeat ─────────────────────────────────────────────────
test("criterion 3: a failed state poll keeps the last state and never stops the animation", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const fetchApi = createFetch();
  const { plugin } = loadPlugin({ clock, transport, fetchApi, settings: { FrameIntervalMs: 100 } });

  await clock.advance(100);
  const seeded = status(plugin);
  assert.equal(seeded.state, "idle", "the load-time GET seeds the state");
  assert.equal(seeded.lastError, null);
  const framesBefore = seeded.framesSent;

  fetchApi.stateFails = true;
  await clock.advance(5100); // the 5 s heartbeat fires and rejects

  const snapshot = status(plugin);
  assert.ok(snapshot.lastError.includes("state poll failed"), "the failure is visible in lastError");
  assert.equal(snapshot.state, "idle", "the last known state survives a failed poll");
  assert.ok(snapshot.framesSent > framesBefore, "the animation keeps running");
  assert.equal(snapshot.active, true);
});

// ── criterion 4. restore fallback ───────────────────────────────────────────
test("criterion 4: restore falls back to the stored palette, then gives up silently", async () => {
  // preview/clear unavailable (older build: 404) → GET /ledStrip + two raw writes
  {
    const clock = createClock(T0);
    const transport = createTransport();
    const fetchApi = createFetch();
    fetchApi.clearStatus = 404;
    const { plugin, logs } = loadPlugin({ clock, transport, fetchApi, settings: { FrameIntervalMs: 100 } });

    await clock.advance(0);
    const writesBefore = transport.sent.length;
    assert.ok(writesBefore > 0, "animating before the machine sleeps");
    emitState(plugin, fetchApi, "sleeping");
    await clock.advance(100);

    assert.equal(fetchApi.count("POST", CLEAR_URL), 1, "preview/clear attempted");
    assert.equal(fetchApi.count("GET", LEDSTRIP_URL), 1, "palette read for the fallback");
    const restores = decodeWrites(transport).slice(writesBefore);
    assert.equal(restores.length, 2, "two raw writes for the sleeping phase");
    // sleeping palette high bytes: front "FF0000000000" → 0xFF0000,
    // back "0000FF000000" → 0x00FF00
    assert.deepEqual(restores.map((w) => w.addr), [FRONT_ADDR, BACK_ADDR]);
    assert.equal(restores[0].value, 0xff0000, "frontLedColor ← frontStrip.sleeping high bytes");
    assert.equal(restores[1].value, 0x00ff00, "rearLedColor ← backStrip.sleeping high bytes");
    assert.equal(status(plugin).restores, 1);
    assert.ok(!logs.some((l) => l.includes("gave up")), "a successful fallback is not a give-up");
  }

  // both paths fail → give up silently, log once, never throw
  {
    const clock = createClock(T0);
    const transport = createTransport();
    const fetchApi = createFetch();
    fetchApi.clearStatus = 404;
    fetchApi.ledStripStatus = 503;
    const { plugin, logs } = loadPlugin({ clock, transport, fetchApi, settings: { FrameIntervalMs: 100 } });

    await clock.advance(0);
    const writesBefore = transport.sent.length;
    emitState(plugin, fetchApi, "sleeping");
    await clock.advance(100);

    assert.equal(fetchApi.count("GET", LEDSTRIP_URL), 1, "fallback attempted");
    const giveUps = logs.filter((l) => l.includes("gave up"));
    assert.equal(giveUps.length, 1, "logged once");
    assert.equal(status(plugin).restores, 1);
    assert.equal(transport.sent.length, writesBefore, "no raw writes after both paths failed");
  }
});

// ── criterion 10. settings validation ───────────────────────────────────────
test("criterion 10: invalid settings fall back to the documented defaults", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const { plugin } = loadPlugin({
    clock,
    transport,
    settings: {
      Preset: "nope",
      BreathingColor: "   ",
      Brightness: 0,
      FrameIntervalMs: 5,
      PlaythroughPressureMax: 0,
      PlaythroughFlowMax: -3,
    },
  });

  // onLoad did not throw and the defaults are in force
  await clock.advance(0);
  const snapshot = status(plugin);
  assert.equal(snapshot.preset, "rainbow", "preset nope → rainbow");
  assertChannels(fronts(transport).at(-1), [255, 0, 0], "brightness 0 → 100 (full rainbow)");

  // FrameIntervalMs 5 → 80: 4 frames in 320 ms
  await clock.advance(320);
  assert.equal(status(plugin).framesSent, 5, "frames are paced at the default 80 ms");

  // and an empty/absent settings object behaves the same
  for (const settings of [undefined, null, {}, { Brightness: 120, FrameIntervalMs: 1001 }]) {
    const other = loadPlugin({ clock: createClock(T0), settings });
    await other.clock.advance(0);
    const snap = status(other.plugin);
    assert.equal(snap.preset, "rainbow");
    assert.ok(other.transport.sent.length >= 2, "still animating with a valid colour");
  }
});

// ── unload ─────────────────────────────────────────────────────────────────
test("onUnload stops the loop, closes the transport and restores once", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const fetchApi = createFetch();
  const { plugin } = loadPlugin({ clock, transport, fetchApi, settings: { FrameIntervalMs: 100 } });

  await clock.advance(200);
  const writesBefore = transport.sent.length;
  const callsBefore = fetchApi.calls.length;

  plugin.onUnload();
  plugin.onUnload(); // idempotent
  await clock.flush();

  assert.deepEqual(transport.closed, ["h1"], "transport closed once");
  assert.equal(fetchApi.count("POST", CLEAR_URL), 1, "restore started once");

  await clock.advance(2000);
  assert.equal(transport.sent.length, writesBefore, "no frames after unload");
  assert.equal(fetchApi.calls.length, callsBefore + 1, "no heartbeat after unload");
  assert.equal(status(plugin).active, false);
});

// ── async lifecycle races ───────────────────────────────────────────────────
test("race: sleeping during a pending send aborts the frame and never resumes the loop", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const fetchApi = createFetch();
  const { plugin } = loadPlugin({ clock, transport, fetchApi, settings: { FrameIntervalMs: 100 } });

  transport.deferSends = true;
  await clock.advance(0);
  assert.equal(transport.sent.length, 1, "front write in flight");

  plugin.onEvent({ name: "stateUpdate", payload: { state: { state: "sleeping", substate: "sleeping" } } });
  await clock.flush();

  // the interrupted send settles only after the machine is asleep
  transport.deferSends = false;
  transport.release();
  await clock.advance(500);

  const snapshot = status(plugin);
  assert.equal(snapshot.restores, 1, "still exactly one restore");
  assert.equal(snapshot.framesSent, 0, "the interrupted frame is not counted as sent");
  assert.equal(transport.sent.length, 1, "the back-strip half of the frame is not written");
  assert.equal(snapshot.active, false);
});

test("race: an open that completes while asleep does not start the loop", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const fetchApi = createFetch();
  transport.deferOpens = true;
  const { plugin } = loadPlugin({ clock, transport, fetchApi, settings: { FrameIntervalMs: 100 } });

  await clock.advance(0);
  assert.equal(transport.opens.length, 1, "open is pending");
  assert.equal(transport.sent.length, 0, "nothing sent before the socket is open");

  plugin.onEvent({ name: "stateUpdate", payload: { state: { state: "sleeping", substate: "sleeping" } } });
  fetchApi.state.state.state = "sleeping";
  await clock.flush();

  transport.deferOpens = false;
  transport.releaseOpen();
  await clock.advance(500);
  assert.equal(transport.sent.length, 0, "no frames after a stale open completes during sleep");
  assert.equal(status(plugin).restores, 1);

  // waking still works on the connection that finished opening
  fetchApi.state.state.state = "idle";
  plugin.onEvent({ name: "stateUpdate", payload: { state: { state: "idle", substate: "idle" } } });
  await clock.advance(100);
  assert.ok(transport.sent.length > 0, "wake resumes on the opened handle");
  assert.equal(transport.sent.at(-1).handle, "h1");
});

test("race: a stale close from a retired handle does not tear down the new connection", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const fetchApi = createFetch();
  const { plugin } = loadPlugin({ clock, transport, fetchApi, settings: { FrameIntervalMs: 100 } });

  await clock.advance(100);
  assert.equal(transport.opens.length, 1);
  const staleHandle = "h1";

  transport.emit(staleHandle, { type: "close", code: 1006, reason: "peer gone" });
  await clock.flush();
  await clock.advance(1000);
  assert.equal(transport.opens.length, 2, "reopened");
  assert.equal(status(plugin).transport, "open");

  const writesBefore = transport.sent.length;
  // a late event for the retired handle must be inert
  transport.emit(staleHandle, { type: "close", code: 1006, reason: "late" });
  transport.emit(staleHandle, { type: "error", code: "transport_error", message: "late" });
  await clock.advance(200);

  assert.equal(status(plugin).transport, "open", "the live handle stays open");
  assert.equal(transport.opens.length, 2, "no reconnect for a retired handle");
  assert.ok(transport.sent.length > writesBefore, "frames keep flowing on the live handle");
  assert.equal(transport.sent.at(-1).handle, "h2");
});

// ── regressions from the first review round ─────────────────────────────────
test("regression: no frame is written before the first machine state is known", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const fetchApi = createFetch();
  fetchApi.fn = () => new Promise(() => {}); // the state poll never answers
  const { plugin } = loadPlugin({ clock, transport, fetchApi, settings: { FrameIntervalMs: 50 } });

  await clock.advance(400);

  assert.equal(transport.sent.length, 0, "a sleeping machine must not be coloured while the state is unknown");
  assert.equal(transport.opens.length, 0, "no socket is opened just to guess");
  assert.ok(status(plugin).framesSkipped > 0, "the loop is armed but skips frames");
});

test("regression: the sleep restore waits for the frame already handed to the transport", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const fetchApi = createFetch();
  const { plugin } = loadPlugin({ clock, transport, fetchApi, settings: { FrameIntervalMs: 100 } });

  transport.deferSends = true;
  await clock.advance(0);
  assert.equal(transport.sent.length, 1, "front write in flight");

  emitState(plugin, fetchApi, "sleeping");
  await clock.flush();
  assert.equal(fetchApi.count("POST", CLEAR_URL), 0, "restore is ordered behind the in-flight write");

  transport.deferSends = false;
  transport.release();
  await clock.advance(200);

  assert.equal(fetchApi.count("POST", CLEAR_URL), 1, "restore runs once the write settled");
  assert.equal(transport.sent.length, 1, "no further frames while asleep");
});

test("regression: a reconnect rewrites both registers even when the colour is unchanged", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const fetchApi = createFetch();
  // steady playthrough colour: espresso at zero pressure and flow never changes
  const { plugin } = loadPlugin({
    clock,
    transport,
    fetchApi,
    settings: { Preset: "playthrough", FrameIntervalMs: 100 },
  });
  // Let the load-time poll settle first, otherwise it lands after emitState and
  // overwrites the espresso state with the fake's default idle.
  await clock.advance(0);
  emitState(plugin, fetchApi, "espresso", 0, 0);
  await clock.advance(400);
  assert.equal(status(plugin).state, "espresso", "steady playthrough state applied");
  assert.ok(status(plugin).writesDeduped > 0, "a steady colour is de-duplicated");

  const handle = [...transport.handles.keys()][0];
  transport.emit(handle, { type: "close", code: 1006, reason: "peer" });
  const before = transport.sent.length;
  await clock.advance(1500); // 1 s backoff, then frames resume

  assert.equal(status(plugin).transport, "open", "reconnected");
  assert.ok(transport.sent.length - before >= 2, "both registers rewritten after recovery");
});

test("regression: unload restores from the palette over the still-open transport", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const fetchApi = createFetch();
  fetchApi.clearStatus = 404; // preview/clear unavailable (older builds)
  const { plugin } = loadPlugin({ clock, transport, fetchApi, settings: { FrameIntervalMs: 100 } });

  await clock.advance(0);
  const before = transport.sent.length;
  assert.ok(before > 0, "animating before unload");

  plugin.onUnload();
  await clock.flush();
  await clock.flush();

  const restores = decodeWrites(transport).slice(before);
  assert.deepEqual(
    restores.map((w) => w.addr),
    [FRONT_ADDR, BACK_ADDR],
    "the palette fallback wrote both registers during unload",
  );
  assert.equal(restores[0].value, 0xffd9a8, "front <- frontStrip.awake high bytes");
  assert.equal(restores[1].value, 0x00ff00, "back <- backStrip.awake high bytes");
  assert.deepEqual(transport.closed, ["h1"], "transport closed once the restore settled");
});

test("regression: a stale REST snapshot cannot wake a sleeping machine", async () => {
  const clock = createClock(T0);
  const transport = createTransport();
  const fetchApi = createFetch();
  const { plugin } = loadPlugin({ clock, transport, fetchApi, settings: { FrameIntervalMs: 100 } });
  await clock.advance(0); // load-time poll (no timestamp on the fake's default body)

  const sleeping = {
    timestamp: new Date(T0 + 1000).toISOString(),
    state: { state: "sleeping", substate: "idle" },
    pressure: 0,
    flow: 0,
  };
  fetchApi.state = sleeping;
  plugin.onEvent({ name: "stateUpdate", payload: sleeping });
  await clock.advance(100);

  const asleep = status(plugin);
  assert.equal(asleep.active, false, "suspended on the sleep event");
  assert.equal(asleep.restores, 1, "one restore for the transition");

  // The 5 s heartbeat now answers with a snapshot taken BEFORE the sleep event: the
  // REST body can lag the event stream, and applying it would paint the strip again.
  fetchApi.state = {
    timestamp: new Date(T0).toISOString(),
    state: { state: "idle", substate: "idle" },
    pressure: 0,
    flow: 0,
  };
  await clock.advance(5200);

  const after = status(plugin);
  assert.equal(after.state, "sleeping", "the stale poll is ignored");
  assert.equal(after.active, false, "still suspended");
  assert.equal(after.framesSent, asleep.framesSent, "no frame is painted after the stale poll");
  assert.equal(after.restores, 1, "no second restore");
});
