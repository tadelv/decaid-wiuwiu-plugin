/* wiuwiu.reaplugin — Wiu Wiu RGB
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Vid
 *
 * Host contract (doc/Plugins.md §2): this is a host script, not a module. It
 * defines the global function createPlugin(host) and returns
 * { id, version, onLoad, onEvent, onUnload }. `handleHttpRequest` is also on the
 * returned object because the loader aliases it to __httpRequestHandler
 * (lib/src/plugins/plugin_manager.dart:2351-2353) to serve the `status` endpoint.
 *
 * Runtime constraints (lib/src/plugins/plugin_manager.dart:2089-2160): the
 * wrapper scope provides setTimeout/clearTimeout, fetch, and the host object —
 * there is no setInterval, no global WebSocket and no console.
 *
 * Protocol facts: docs/protocol.md. The raw socket carries the ~10 Hz A013
 * notification stream, so inbound handling is O(1) and allocates at most one
 * JSON.parse per frame.
 */
function createPlugin(host) {
  "use strict";

  var PLUGIN_ID = "wiuwiu.reaplugin";
  var VERSION = "0.2.1";

  var WS_URL = "ws://localhost:8080/ws/v1/machine/raw";
  var STATE_URL = "http://localhost:8080/api/v1/machine/state";
  var LEDSTRIP_URL = "http://localhost:8080/api/v1/machine/ledStrip";
  var CLEAR_URL = "http://localhost:8080/api/v1/machine/ledStrip/preview/clear";

  // frontLedColor = 0x00803890, rearLedColor = 0x00803894. The on-wire address
  // field is the full 32-bit address big-endian with its first byte replaced by
  // the length, so the three bytes kept are 80 38 90 / 80 38 94 — not the low 24
  // bits (00 38 90 is address 0x003890, and Decaid answers a write for any A006
  // frame, so an acknowledgement does not prove the register). See
  // docs/protocol.md §2.
  var FRONT_ADDR = "803890";
  var BACK_ADDR = "803894";

  // Matched exactly and case-sensitively: "a006" is silently dropped as an
  // unknown endpoint (docs/protocol.md §2, trap 1).
  var WRITE_UUID = "A006";

  // 20-byte payload = 1 length byte + 3 address bytes + uint32 LE value + 12 pad.
  var ZERO_PAD = "000000000000000000000000";

  var HEARTBEAT_MS = 5000;
  var RAINBOW_PERIOD_MS = 6000;
  var BREATH_PERIOD_MS = 4000;
  var RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];

  var PRESETS = ["rainbow", "breathing", "playthrough"];
  // playthrough only engages for these four machine states; everything else hands the
  // strips back to the stored palette (the machine's own colours) until one of them
  // comes round again.
  var ENGAGING_STATES = ["espresso", "steam", "flush", "hotWater"];
  var AMBER = [255, 154, 60];

  var DEFAULTS = {
    preset: "rainbow",
    breathingColor: "#FFD9A8",
    brightness: 100,
    frameIntervalMs: 80,
    pressureMax: 12,
    flowMax: 6
  };

  // ── clock seam (test-only) ────────────────────────────────────────────────
  // Every timestamp in this plugin goes through now(). Production reads the real
  // Date.now(); test/plugin.test.mjs installs a fake clock through the
  // plugin.__setNow() setter on the returned object (pass null to restore).
  var nowFn = null;

  function now() {
    return nowFn ? nowFn() : Date.now();
  }

  // ── state ─────────────────────────────────────────────────────────────────
  var settings = readSettings(null);
  var loaded = false;
  var unloading = false;
  var loadedAt = 0;
  var t0 = 0;

  var machineState = null;
  var substate = null;
  var pressure = 0;
  var flow = 0;
  var suspended = false;
  // Machine-clock timestamp of the newest snapshot applied. The event stream and the
  // REST heartbeat describe the same thing at different latencies, so an older poll
  // answer can arrive after a newer event and would otherwise un-suspend a sleeping
  // machine for a moment (observed: a second restore and 3 frames after sleep).
  var lastSnapshotAt = null;

  var frameTimer = null;
  var heartbeatTimer = null;
  var retryTimer = null;
  var retryIndex = 0;

  var inFlight = false;
  var framePromise = null; // settles when the frame in flight is done
  var lastFront = null;
  var lastBack = null;
  var lastFrameAt = null;

  var handle = null; // live transport handle, null when not open
  var openState = "closed"; // "closed" | "open"
  var openPromise = null;

  var stats = {
    framesSent: 0,
    framesSkipped: 0,
    writesWritten: 0,
    writesDeduped: 0,
    framesIgnored: 0,
    restores: 0,
    lastError: null
  };

  // ── small helpers ─────────────────────────────────────────────────────────
  function logLine(message) {
    try {
      if (host && typeof host.log === "function") {
        host.log("[" + PLUGIN_ID + "] " + message);
      }
    } catch (e) {
      // logging must never break the animation
    }
  }

  function errMessage(error) {
    if (error && typeof error.message === "string") return error.message;
    return String(error);
  }

  function noteError(message) {
    stats.lastError = message;
  }

  function hex2(value) {
    var text = (value & 0xff).toString(16).toUpperCase();
    return text.length < 2 ? "0" + text : text;
  }

  function hex24(value) {
    if (value === null || value === undefined) return null;
    var text = (value >>> 0).toString(16).toUpperCase();
    while (text.length < 6) text = "0" + text;
    return text.slice(-6);
  }

  function clamp01(value) {
    if (!(value > 0)) return 0;
    return value > 1 ? 1 : value;
  }

  function channel(value, factor) {
    var out = Math.round(value * factor);
    if (!(out > 0)) return 0;
    return out > 255 ? 255 : out;
  }

  function pack(r, g, b) {
    return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
  }

  function scaled(r, g, b, factor) {
    return pack(channel(r, factor), channel(g, factor), channel(b, factor));
  }

  function hexTripleToRgb(hex) {
    var n = Number("0x" + hex.slice(1));
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // ── settings ──────────────────────────────────────────────────────────────
  function numeric(value, min, max, fallback) {
    var n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n < min || n > max) return fallback;
    return n;
  }

  function positive(value, fallback) {
    var n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n;
  }

  function colourSetting(value, fallback) {
    if (typeof value !== "string") return fallback;
    var text = value.trim().toUpperCase();
    if (text.charAt(0) === "#") text = text.slice(1);
    if (text.length !== 6) return fallback;
    for (var i = 0; i < 6; i += 1) {
      if ("0123456789ABCDEF".indexOf(text.charAt(i)) < 0) return fallback;
    }
    return "#" + text;
  }

  function readSettings(raw) {
    var source = raw && typeof raw === "object" ? raw : {};

    var preset = DEFAULTS.preset;
    if (typeof source.Preset === "string") {
      var candidate = source.Preset.trim().toLowerCase();
      if (PRESETS.indexOf(candidate) >= 0) preset = candidate;
    }

    return {
      preset: preset,
      breathingColor: colourSetting(source.BreathingColor, DEFAULTS.breathingColor),
      brightness: numeric(source.Brightness, 5, 100, DEFAULTS.brightness),
      frameIntervalMs: numeric(source.FrameIntervalMs, 20, 1000, DEFAULTS.frameIntervalMs),
      pressureMax: positive(source.PlaythroughPressureMax, DEFAULTS.pressureMax),
      flowMax: positive(source.PlaythroughFlowMax, DEFAULTS.flowMax)
    };
  }

  // ── effects ───────────────────────────────────────────────────────────────
  function hueToRgb(hue) {
    var h = hue / 60;
    var x = 1 - Math.abs((h % 2) - 1);
    var r = 0;
    var g = 0;
    var b = 0;
    if (h < 1) { r = 1; g = x; }
    else if (h < 2) { r = x; g = 1; }
    else if (h < 3) { g = 1; b = x; }
    else if (h < 4) { g = x; b = 1; }
    else if (h < 5) { r = x; b = 1; }
    else { r = 1; b = x; }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  function breatheAlpha(t) {
    return (1 - Math.cos(2 * Math.PI * ((t - t0) / BREATH_PERIOD_MS))) / 2;
  }

  function breatheValue(rgb, t, factor) {
    return scaled(rgb[0], rgb[1], rgb[2], breatheAlpha(t) * factor);
  }

  function playthroughFrame(t, bright) {
    // Only reachable while a state in ENGAGING_STATES is current (see shouldAnimate).
    if (machineState === "steam") {
      // Pressure and flow carry no meaning while steaming.
      var amber = breatheValue(AMBER, t, bright);
      return { front: amber, back: amber };
    }

    // pressure → back strip, dim blue-green to bright green
    var tp = clamp01(pressure / settings.pressureMax);
    var back = scaled(0, 60 + 195 * tp, 90 * (1 - tp), bright);
    // flow → front strip, dim indigo to bright blue
    var tf = clamp01(flow / settings.flowMax);
    var front = scaled(0, 60 * (1 - tf), 120 + 135 * tf, bright);
    return { front: front, back: back };
  }

  function computeFrame(t) {
    var bright = settings.brightness / 100;

    if (settings.preset === "breathing") {
      var base = hexTripleToRgb(settings.breathingColor);
      var value = breatheValue(base, t, bright);
      return { front: value, back: value };
    }

    if (settings.preset === "playthrough") {
      return playthroughFrame(t, bright);
    }

    // rainbow: 6 s per revolution, full saturation and value; the front switch
    // follows the front strip, so both registers carry the same colour.
    var hue = (((t - t0) / RAINBOW_PERIOD_MS) * 360) % 360;
    if (hue < 0) hue += 360;
    var rgb = hueToRgb(hue);
    var rainbow = scaled(rgb[0], rgb[1], rgb[2], bright);
    return { front: rainbow, back: rainbow };
  }

  // ── raw write frames ──────────────────────────────────────────────────────
  function littleEndianHex(value) {
    var v = value >>> 0;
    return hex2(v) + hex2(v >>> 8) + hex2(v >>> 16) + hex2(v >>> 24);
  }

  function buildFrame(addressHex, value) {
    return JSON.stringify({
      type: "request",
      operation: "write",
      characteristicUUID: WRITE_UUID,
      payload: "04" + addressHex + littleEndianHex(value) + ZERO_PAD
    });
  }

  // ── timers ────────────────────────────────────────────────────────────────
  function stopFrameLoop() {
    if (frameTimer !== null) {
      clearTimeout(frameTimer);
      frameTimer = null;
    }
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function stopRetry() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  // ── transport ─────────────────────────────────────────────────────────────
  function ensureTransport() {
    // An open handle stays usable while unloading: the unload restore may need
    // one last raw write (the palette fallback). Anything else is refused, and no
    // new connection is ever opened while unloading.
    if (openState === "open" && handle) return Promise.resolve(handle);
    if (unloading) return Promise.resolve(null);
    if (openPromise) return openPromise;

    openPromise = host.transport
      .open({ kind: "websocket", url: WS_URL })
      .then(function (opened) {
        openPromise = null;
        var openedHandle = opened && opened.handle;
        if (!openedHandle) throw new Error("transport.open resolved without a handle");
        handle = openedHandle;
        openState = "open";
        retryIndex = 0;
        stopRetry();
        // The listener must exist before the first send; the host retains events
        // that arrive between open() resolving and onEvent() registering
        // (doc/Plugins.md §host.transport.onEvent). The handle check keeps a
        // retired handle's late events inert.
        host.transport.onEvent(openedHandle, function (event) {
          if (openedHandle !== handle) return;
          onTransportEvent(event);
        });
        resumeAfterOpen();
        return openedHandle;
      })
      .catch(function (error) {
        openPromise = null;
        handle = null;
        openState = "closed";
        noteError("transport open failed: " + errMessage(error));
        scheduleReconnect();
        return null;
      });

    return openPromise;
  }

  function resumeAfterOpen() {
    if (!loaded || unloading || suspended) return;
    scheduleNextFrame(0);
  }

  function onTransportDown(reason) {
    handle = null;
    openState = "closed";
    noteError(reason);
    // A send resolves when the host accepted it, not when the machine received it,
    // so a socket drop can lose the write the cache believes happened. Forget the
    // per-register cache: the first frame after recovery must write.
    lastFront = null;
    lastBack = null;
    stopFrameLoop();
    scheduleReconnect();
  }

  function onTransportEvent(event) {
    if (!event || typeof event !== "object") return;

    if (event.type === "data") {
      if (event.dataType !== "text" || typeof event.data !== "string") return;
      var message = null;
      try {
        message = JSON.parse(event.data);
      } catch (e) {
        stats.framesIgnored += 1;
        return;
      }
      // Our own A006 write echo is recognised; everything else — the ~10 Hz A013
      // shot-sample notifications and A005 notes — is counted and dropped.
      if (message && message.operation === "write" && message.characteristicUUID === WRITE_UUID) return;
      stats.framesIgnored += 1;
      return;
    }

    if (event.type === "close") {
      onTransportDown("transport closed" + (event.code ? " (" + event.code + ")" : ""));
      return;
    }

    if (event.type === "error") {
      onTransportDown("transport error: " + (event.message || event.code || "unknown"));
    }
  }

  function scheduleReconnect() {
    if (!loaded || unloading || suspended) return;
    if (retryTimer !== null) return;
    var index = retryIndex < RECONNECT_DELAYS_MS.length ? retryIndex : RECONNECT_DELAYS_MS.length - 1;
    var delay = RECONNECT_DELAYS_MS[index];
    retryIndex += 1;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (!loaded || unloading || suspended) return;
      ensureTransport();
    }, delay);
  }

  // ── writes ────────────────────────────────────────────────────────────────
  function writeRegister(addressHex, value, ignoreSuspension) {
    var isFront = addressHex === FRONT_ADDR;
    var last = isFront ? lastFront : lastBack;

    if (last === value) {
      stats.writesDeduped += 1;
      return Promise.resolve(true);
    }

    return ensureTransport().then(function (activeHandle) {
      if (!activeHandle) return false;
      // The open may have completed after the machine went to sleep; the restore
      // path is the one caller allowed to write while suspended.
      if (!ignoreSuspension && (unloading || suspended)) return false;
      return host.transport
        .send(activeHandle, { type: "text", data: buildFrame(addressHex, value) })
        .then(function () {
          stats.writesWritten += 1;
          if (isFront) lastFront = value;
          else lastBack = value;
          return true;
        })
        .catch(function (error) {
          onTransportDown("transport send failed: " + errMessage(error));
          throw error;
        });
    });
  }

  // ── animation loop ───────────────────────────────────────────────────────
  function scheduleNextFrame(delay) {
    if (!loaded || unloading || suspended) return;
    if (frameTimer !== null) return;
    frameTimer = setTimeout(function () {
      frameTimer = null;
      if (!loaded || unloading || suspended) return;
      runFrame();
      scheduleNextFrame(settings.frameIntervalMs);
    }, delay);
  }

  function runFrame() {
    if (!loaded || unloading || suspended) return;
    // No frame before the first machine state is known: a freshly loaded plugin
    // must not colour a sleeping machine while its first state poll is in flight.
    if (machineState === null) {
      stats.framesSkipped += 1;
      return;
    }
    if (inFlight) {
      // A send is still unsettled: skip this frame rather than queue it.
      stats.framesSkipped += 1;
      return;
    }

    inFlight = true;
    var at = now();
    var frame = computeFrame(at);

    framePromise = writeRegister(FRONT_ADDR, frame.front)
      .then(function () {
        // The machine may have gone to sleep while the front write was in flight.
        if (unloading || suspended) return false;
        return writeRegister(BACK_ADDR, frame.back);
      })
      .then(function (completed) {
        if (completed === false) {
          // No transport available, or the machine went to sleep mid-frame: this
          // tick produced no frame, and framesSent + framesSkipped should still
          // account for it.
          stats.framesSkipped += 1;
          return;
        }
        stats.framesSent += 1;
        lastFrameAt = at;
      })
      .catch(function () {
        // The failure was recorded by writeRegister/onTransportDown; the loop
        // keeps its cadence and the transport reopens with backoff.
      })
      .then(function () {
        inFlight = false;
      });
  }

  // ── machine state ─────────────────────────────────────────────────────────
  function applySnapshot(payload) {
    if (!payload || typeof payload !== "object") return;

    // Newest wins. Both sources carry the machine's own timestamp, so ordering them
    // is exact; an unparsable or absent timestamp is still applied (be permissive).
    var at = typeof payload.timestamp === "string" ? Date.parse(payload.timestamp) : NaN;
    if (Number.isFinite(at)) {
      if (lastSnapshotAt !== null && at < lastSnapshotAt) return;
      lastSnapshotAt = at;
    }

    var state = payload.state;
    if (state && typeof state === "object") {
      if (typeof state.state === "string") machineState = state.state;
      if (typeof state.substate === "string") substate = state.substate;
    }
    if (typeof payload.pressure === "number" && Number.isFinite(payload.pressure)) {
      pressure = payload.pressure;
    }
    if (typeof payload.flow === "number" && Number.isFinite(payload.flow)) {
      flow = payload.flow;
    }

    syncSuspension();
  }

  // Whether this preset should be painting at all in the current machine state.
  // rainbow/breathing run whenever the machine is awake; playthrough runs only while
  // the machine is actually doing one of its four jobs.
  function shouldAnimate() {
    if (machineState === null) return false;
    if (machineState === "sleeping" || machineState === "goingToSleep") return false;
    if (settings.preset !== "playthrough") return true;
    return ENGAGING_STATES.indexOf(machineState) >= 0;
  }

  function syncSuspension() {
    var suspendedNow = !shouldAnimate();
    if (suspendedNow === suspended) return;
    suspended = suspendedNow;
    if (suspendedNow) {
      enterSuspend(machineState === "sleeping" || machineState === "goingToSleep"
        ? "sleep"
        : "disengaged");
    } else {
      wake();
    }
  }

  function enterSuspend(reason) {
    // No frames at all while suspended: stop the loop, drop any in-flight retry and
    // hand the live registers back for this transition only. The restore waits for
    // the frame already handed to the transport, so a late write cannot land after
    // the palette has been restored.
    stopFrameLoop();
    stopRetry();
    retryIndex = 0;
    startRestore(reason, framePromise);
  }

  function wake() {
    // Force the next frame: clear the per-register de-duplication cache so the
    // colour is written even when it is unchanged from before the sleep.
    lastFront = null;
    lastBack = null;
    retryIndex = 0;
    scheduleNextFrame(0);
  }

  function pollState() {
    var request;
    try {
      request = fetch(STATE_URL);
    } catch (error) {
      noteError("state poll failed: " + errMessage(error));
      return Promise.resolve(false);
    }

    return Promise.resolve(request)
      .then(function (response) {
        if (!response || !response.ok) throw new Error("HTTP " + (response && response.status));
        return response.json();
      })
      .then(function (snapshot) {
        applySnapshot(snapshot);
        return true;
      })
      .catch(function (error) {
        // A failed poll keeps the last known state and never stops the animation.
        noteError("state poll failed: " + errMessage(error));
        return false;
      });
  }

  function scheduleHeartbeat() {
    if (!loaded || unloading) return;
    if (heartbeatTimer !== null) return;
    heartbeatTimer = setTimeout(function () {
      heartbeatTimer = null;
      if (!loaded || unloading) return;
      pollState();
      scheduleHeartbeat();
    }, HEARTBEAT_MS);
  }

  // ── restore ───────────────────────────────────────────────────────────────
  // Color16.toJson() is a 12-char RRRRGGGGBBBB string
  // (lib/src/models/device/led_strip.dart:16-39); the registers take the high
  // byte of each 16-bit channel.
  function paletteValue(palette, zone, phase) {
    var zones = palette && typeof palette === "object" ? palette[zone] : null;
    var hex = zones && typeof zones === "object" ? zones[phase] : null;
    if (typeof hex !== "string" || hex.length < 12) throw new Error("palette." + zone + "." + phase + " unusable");
    var r = Number("0x" + hex.slice(0, 4)) >> 8;
    var g = Number("0x" + hex.slice(4, 8)) >> 8;
    var b = Number("0x" + hex.slice(8, 12)) >> 8;
    return pack(r, g, b);
  }

  function restoreFromPalette() {
    var phase = machineState === "sleeping" ? "sleeping" : "awake";

    return Promise.resolve()
      .then(function () {
        return fetch(LEDSTRIP_URL);
      })
      .then(function (response) {
        if (!response || !response.ok) throw new Error("ledStrip HTTP " + (response && response.status));
        return response.json();
      })
      .then(function (palette) {
        var front = paletteValue(palette, "frontStrip", phase);
        var back = paletteValue(palette, "backStrip", phase);
        // The palette colours replace whatever we last wrote, so forget the
        // de-duplication cache before writing them back.
        lastFront = null;
        lastBack = null;
        return writeRegister(FRONT_ADDR, front, true).then(function (frontOk) {
          if (!frontOk) throw new Error("raw restore unavailable");
          return writeRegister(BACK_ADDR, back, true);
        });
      })
      .then(function (backOk) {
        if (!backOk) throw new Error("raw restore unavailable");
        return true;
      });
  }

  function startRestore(reason, waitFor) {
    stats.restores += 1;

    return Promise.resolve(waitFor)
      .catch(function () {})
      .then(function () {
        var request;
        try {
          request = fetch(CLEAR_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}"
          });
        } catch (error) {
          request = Promise.reject(error);
        }

        return Promise.resolve(request)
          .then(function (response) {
            if (!response || !response.ok) throw new Error("preview/clear HTTP " + (response && response.status));
            return true;
          })
          .catch(function (error) {
            logLine("preview/clear failed (" + errMessage(error) + ") during " + reason + "; restoring from the stored palette");
            return restoreFromPalette();
          })
          .catch(function (error) {
            // Both paths failed. The firmware recomputes the live pair at the next
            // sleep/wake transition anyway (docs/protocol.md §4), so give up quietly.
            logLine("restore gave up during " + reason + ": " + errMessage(error));
            return false;
          });
      });
  }

  // ── status ────────────────────────────────────────────────────────────────
  function statusSnapshot() {
    return {
      preset: settings.preset,
      state: machineState,
      substate: substate,
      active: loaded && !unloading && !suspended,
      transport: openState,
      framesSent: stats.framesSent,
      framesSkipped: stats.framesSkipped,
      writesWritten: stats.writesWritten,
      writesDeduped: stats.writesDeduped,
      lastFront: hex24(lastFront),
      lastBack: hex24(lastBack),
      lastFrameAt: lastFrameAt === null ? null : new Date(lastFrameAt).toISOString(),
      restores: stats.restores,
      lastError: stats.lastError,
      pressure: pressure,
      flow: flow,
      uptimeMs: loaded ? now() - loadedAt : 0,
      // Not in the spec's example payload: inbound A013/A005 frames dropped by
      // the raw socket, counted so the ignore path is observable.
      framesIgnored: stats.framesIgnored
    };
  }

  // ── plugin object ─────────────────────────────────────────────────────────
  var plugin = {
    id: PLUGIN_ID,
    version: VERSION,

    onLoad: function (rawSettings) {
      try {
        loadedAt = now();
        t0 = loadedAt;
        try {
          settings = readSettings(rawSettings);
        } catch (error) {
          settings = readSettings(null);
        }
        loaded = true;
        unloading = false;
        logLine(
          "loaded: preset=" + settings.preset +
          " brightness=" + settings.brightness +
          " frameIntervalMs=" + settings.frameIntervalMs
        );
        pollState();
        scheduleHeartbeat();
        scheduleNextFrame(0);
      } catch (error) {
        logLine("onLoad failed: " + errMessage(error));
      }
    },

    onEvent: function (event) {
      try {
        if (!event || typeof event !== "object") return;
        if (event.name === "stateUpdate") {
          applySnapshot(event.payload);
          return;
        }
        if (event.name === "shutdown") {
          plugin.onUnload();
        }
      } catch (error) {
        noteError("onEvent failed: " + errMessage(error));
      }
    },

    onUnload: function () {
      if (unloading) return;
      unloading = true;
      loaded = false;
      suspended = true;

      stopFrameLoop();
      stopHeartbeat();
      stopRetry();
      retryIndex = 0;

      var openHandle = handle;

      // Started, never awaited: unloading must not hang on the network. The handle
      // is closed only after the restore settles, because the palette fallback
      // needs one last raw write through it (ensureTransport allows an already-open
      // handle while unloading).
      var restoreDone;
      try {
        restoreDone = startRestore("unload", framePromise);
      } catch (error) {
        logLine("unload restore failed: " + errMessage(error));
        restoreDone = Promise.resolve(false);
      }

      Promise.resolve(restoreDone)
        .catch(function () {})
        .then(function () {
          if (handle === openHandle) {
            handle = null;
            openState = "closed";
          }
          try {
            if (openHandle) host.transport.close(openHandle);
          } catch (error) {
            // The host closes the generation's transports regardless
            // (doc/Plugins.md §Lifecycle and ownership).
          }
        });
    },

    // Served at /api/v1/plugins/wiuwiu.reaplugin/status. The dispatcher reads
    // {status, headers, body} and hands `body` straight to a shelf Response
    // (lib/src/services/webserver/plugins_handler.dart:420-438), so the snapshot
    // must be a JSON string, not a plain object.
    handleHttpRequest: function (request) {
      return {
        requestId: request && request.requestId,
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache"
        },
        body: JSON.stringify(statusSnapshot())
      };
    },

    // Test-only clock seam; see the comment at its definition above.
    __setNow: function (fn) {
      nowFn = typeof fn === "function" ? fn : null;
    }
  };

  return plugin;
}
