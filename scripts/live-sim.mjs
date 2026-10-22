#!/usr/bin/env node
// Run wiuwiu.reaplugin outside Decaid, against a live instance, through a host
// shim that implements only what the plugin uses (transport.open/onEvent/send/
// close, log, fetch, timers). This is how the plugin's real network behaviour —
// raw LED writes on the live registers, state polling, restore — gets exercised
// before it is installed, and it leaves the strips on the stored palette when it
// exits.
//
//   node scripts/live-sim.mjs                    # 12 s of rainbow
//   SIM_PRESET=playthrough SIM_SECONDS=20 node scripts/live-sim.mjs
//   DECAID_HOST=de1tablet.home:8080 node scripts/live-sim.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = process.env.DECAID_HOST || "de1tablet.home:8080";
const SECONDS = Number(process.env.SIM_SECONDS || 12);
const PRESET = process.env.SIM_PRESET || "rainbow";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const source = fs
  .readFileSync(path.join(ROOT, "wiuwiu.reaplugin/plugin.js"), "utf8")
  .replaceAll("localhost:8080", HOST); // the plugin targets the instance it runs inside

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];
const sockets = new Map();
let seq = 0;

const transport = {
  async open({ url }) {
    const handle = `h${++seq}`;
    const ws = new WebSocket(url);
    const entry = { ws, handlers: [] };
    sockets.set(handle, entry);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    ws.addEventListener("message", (e) => {
      for (const h of entry.handlers) h({ type: "data", dataType: "text", data: String(e.data) });
    });
    ws.addEventListener("close", (e) => {
      for (const h of entry.handlers) h({ type: "close", code: e.code, reason: e.reason });
    });
    console.log(`[sim] transport open ${handle} -> ${url}`);
    return { handle };
  },
  onEvent(handle, cb) {
    const entry = sockets.get(handle);
    if (!entry) throw new Error(`onEvent for unknown handle ${handle}`);
    entry.handlers.push(cb);
  },
  async send(handle, payload) {
    const entry = sockets.get(handle);
    if (!entry) throw new Error(`send on closed handle ${handle}`);
    entry.ws.send(payload.data);
  },
  async close(handle) {
    sockets.get(handle)?.ws.close();
    sockets.delete(handle);
  },
};

const host = { log: (m) => logs.push(String(m)), emit() {}, storage() {}, transport };

const ctx = vm.createContext({ setTimeout, clearTimeout, fetch });
vm.runInContext(source, ctx, { filename: "plugin.js" });
const plugin = ctx.createPlugin(host);
const status = () => JSON.parse(plugin.handleHttpRequest({ requestId: "sim" }).body);

plugin.onLoad({ Preset: PRESET });
console.log(`[sim] loaded against ${HOST}, preset ${PRESET} for ${SECONDS}s — watch the strips\n`);

const seen = [];
for (let i = 1; i <= SECONDS; i += 1) {
  await sleep(1000);
  const s = status();
  seen.push(s);
  console.log(
    `[sim] ${String(i).padStart(2)}s state=${s.state} transport=${s.transport} active=${s.active}` +
      ` frames=${s.framesSent} writes=${s.writesWritten} deduped=${s.writesDeduped}` +
      ` front=${s.lastFront} back=${s.lastBack}${s.lastError ? ` lastError=${s.lastError}` : ""}`,
  );
}

plugin.onUnload();
await sleep(2000);
const after = status();
const last = seen.at(-1) || {};
console.log(`\n[sim] after unload: restores=${after.restores} transport=${after.transport}`);

const problems = [];
if (!last.framesSent) problems.push("no frames were sent — the strips never lit");
if (!last.writesWritten) problems.push("no register writes were accepted");
if (last.lastFront && last.lastFront === seen[0]?.lastFront && PRESET === "rainbow") {
  problems.push("the colour never changed in rainbow mode");
}
if (after.restores < 1) problems.push("unload did not restore the stored palette");
if (last.lastError) problems.push(`last error: ${last.lastError}`);

for (const line of logs) console.log("[plugin]", line);
if (problems.length) {
  console.log("\n[sim] FAIL");
  for (const p of problems) console.log("  -", p);
  process.exit(1);
}
console.log("\n[sim] OK — frames reached the live registers and the palette was restored.");
