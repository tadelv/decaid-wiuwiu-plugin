# Wiu Wiu RGB

A [Decaid](https://github.com/decentespresso/decaid) plugin that turns a Bengle's
LED strips into a disco light, driven by what the machine is actually doing.

Three presets, chosen in Decaid's plugin settings:

| Preset | What it does |
| --- | --- |
| `rainbow` (default) | cycles the whole strip through the hue wheel, all zones together |
| `breathing` | one colour (default warm white) fading 0 → full → 0, all zones together |
| `playthrough` | back strip shows **pressure** as a green ramp, front strip shows **flow** as a blue ramp, shade and brightness both move with the reading; steam goes amber, errors go red, idle breathes a dim teal |

When the machine sleeps the plugin stops writing frames and hands the strips back
to the stored palette, so the machine's own sleep/wake colours win. When it wakes
up, the animation resumes on its own.

It talks to the machine the fast way: raw MMR writes to the two live LED
registers over Decaid's `/ws/v1/machine/raw` WebSocket, one frame per zone, no
REST round trip per frame.

* Behaviour contract: [`docs/spec.md`](docs/spec.md)
* Protocol reference (addresses, frame encoding, traps, install path):
  [`docs/protocol.md`](docs/protocol.md)

## Install

Decaid's REST API only installs plugins from GitHub, so a local build is copied
onto the device and enabled over REST:

```sh
./scripts/deploy.sh            # adb push + restart Decaid + enable + verify
```

Requires the host on the same network (default `de1tablet.home:8080`), `adb` with
the tablet attached, and a **debuggable** Decaid build (the tablet's build is
signed with `android/app/debug.keystore`, so `run-as` works).

## Status

`GET http://<host>:8080/api/v1/plugins/wiuwiu.reaplugin/status` reports the
active preset, machine state, transport state and frame counters — the cheapest
way to confirm it is actually animating.

## Develop

```sh
node --test test/
```

No dependencies, no build step: `plugin.js` is the artifact Decaid loads, and the
tests evaluate it in a `vm` context with a fake host.
