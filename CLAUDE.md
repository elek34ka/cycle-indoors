# Cycle Indoors — working notes

Browser-based indoor cycling app: structured workouts, FTMS trainer control,
BLE sensors, a GPS route as the course you ride, `.fit` export. Frontend only,
no backend yet.

**Read `README.md` for what the app does and how it is laid out.** This file is
for the things the code and the README do not say.

## Commands

```sh
npm run dev      # http://127.0.0.1:5173 — run it in your own terminal, Ctrl+C stops it
npm test         # ~1300 checks, no browser needed; must be green before any deploy
npm run build    # tsc --noEmit + vite build into dist/
```

The dev server is sometimes left running detached from a previous session.
`lsof -ti:5173 | xargs kill` stops it.

## Build phases

1. UI on a simulated trainer — **done**
2. Real Web Bluetooth connections — **done**
3. FTMS trainer control (ERG + simulation) — **done**
4. Polish, then a backend — **current**

Likely next: ride persistence in IndexedDB (a reload currently destroys an
in-progress ride, and it is the prerequisite for reliable Strava upload), then
ride history and a workout library.

Work on this project is delivered in numbered phases. Finish one completely —
code, tests and docs — before starting the next, rather than leaving several
half-built. Ask clarifying questions before starting something large.

## Verification constraints

**The whole suite is designed to need no browser**, which is what makes it
runnable in CI. Verify headlessly, and never claim anything about how the app
*looks* unless you have actually rendered it and seen it. What the suite does
verify:

- `tests/*.test.ts` bundle with esbuild (`scripts/test.mjs`) and run in Node.
- DOM tests boot the real UI in jsdom (`tests/dom-setup.ts`), which stubs canvas
  and gives every element a 320x200 box so Leaflet's zoom maths works.
- BLE is tested against `tests/fake-gatt.ts`, a stand-in GATT stack. Real
  trainers have never been connected to this code.
- The Strava relay (`relay/src/index.ts`) is tested against a stand-in
  `fetch` in `tests/strava-relay.test.ts`; Strava itself is never called.
- FIT encoding and decoding are validated against Garmin's own `@garmin/fitsdk`,
  which independently confirms field numbers, scaling and CRC. Keep doing that
  for any new FIT field — it is the only thing standing between a plausible
  file and one Strava rejects.

Prefer extracting pure functions and testing those over asserting on rendered
output. `xForDistance`/`distanceForX` in `src/ui/elevation-graph.ts` exist as a
pair precisely so the drawing code and the hit test cannot drift apart.

## Traps

- **Speed units differ by layer, deliberately.** `Telemetry.speed` is km/h
  (what sensors report, what the dashboard shows); `TrackPoint.speed` is m/s
  (what GPX and FIT store). Both are documented at their definitions. Check
  before converting.
- **On a route, speed is not the sensors' speed.** `SessionSnapshot.speed` and
  `Sample.speed` are the virtual speed from power + route gradient
  (`stepSpeed` in `physics.ts`). `live.speed` is still the raw sensor value.
  Read `snapshot.speed` for anything the rider sees or the FIT records.
- **FTMS Indoor Bike Data bit 0 is inverted** — "More Data": instantaneous
  speed is present when the bit is *clear*. A test packet got this wrong before
  the parser did.
- **One GATT operation at a time per device.** Every control-point exchange is a
  single slot in one queue (`FtmsControlPoint`). Splitting "request control"
  from "send target" let commands interleave and delivered targets out of
  order. Do not add a second write path.
- **Chrome returns the same characteristic object after a reconnect**, so
  notification listeners stack up and every packet gets handled twice. They are
  scoped to the link with an `AbortController` in `BleDevice`.
- **Lap wraps teleport the rider** to the course start, so altitude deltas over
  8 m/s are discarded when totalling ascent, in both `computeMetrics` and the
  FIT exporter.

## Decisions worth not re-litigating

- `setResistance` is **deliberately unimplemented**: FTMS defines the target as
  a `uint8` at 0.1 resolution, which cannot express the 0–100 ranges trainers
  advertise, and implementations disagree. ERG and simulation cover everything.
- The simulated trainer and strap are **off by default** and folded away under a
  disclosure, and are never auto-started when real hardware is known. Invented
  numbers must never be mistakable for a sensor.
- The mini map **does not keep the rider centred**: it eases the marker every
  frame and only pans once the rider leaves a dead zone. Pinning to the centre
  means the whole world moves on every update, which reads as jitter. It also
  uses the SVG renderer, not canvas, because canvas layers visibly shift
  against the tiles during a pan.
- Leaflet is **lazy-loaded** and the map is not offered at all without a route.
- Elevation is smoothed over a 30 m window before gradient and ascent are
  computed; raw GPS altitude is unusable for gradient.
- A workout running out **does not end the ride** — it hands over to free
  riding until the rider presses Finish.
- `base` in `vite.config.ts` comes from `BASE_PATH` so GitHub Pages can serve
  from a subpath; it stays `/` locally.

## Seams for later work

- `src/devices/types.ts` — `Device` and `TrainerControl`. A Wahoo or Tacx
  adapter implements the same two methods over its own proprietary control
  point and nothing above it changes.
- `src/session/session.ts` — owns every trainer write and throttles them
  (one per 500 ms, latest wins). New control paths belong here, not in the UI.
- `src/activity/fit-export.ts` — already produces an upload-ready activity, so
  the Strava integration needs no new encoding.
- `relay/` — the Strava token relay (Cloudflare Worker), already deployed and
  verified with a real authorization code. Strava requires `client_secret` for
  the code exchange *and* every refresh (access tokens last 6 h, refresh tokens
  rotate) and has no PKCE, so this is not optional. It only ever handles
  tokens; the browser uploads to Strava directly. Never put the secret
  anywhere but `wrangler secret put` or the gitignored `relay/.dev.vars`.
  Strava's API base moves to `https://api-v3.strava.com` from 2027-01-04.
