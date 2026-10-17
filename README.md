# Cycle Indoors

A browser-based indoor cycling app: load a structured workout, control a smart
trainer in ERG or free mode, read heart rate and power from Bluetooth sensors,
and ride against a live workout profile. Load a `.gpx` or `.fit` route and it
becomes the course you are riding — elevation profile under the power graph,
gradient and metres climbed live, route on a hideable corner map. Recorded rides
export as a `.fit` activity.

Inspired by [Auuki](https://auuki.com/) ([source](https://github.com/dvmarinoff/Auuki)).

Frontend only — no backend, no accounts, nothing leaves the browser. Settings
live in `localStorage`; rides are kept in memory until you download them.

## Running it

```sh
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # 551 checks, no browser needed
npm run build      # typecheck + production build into dist/
```

Pairing sensors needs Chrome, Edge or another Chromium browser: Web Bluetooth
does not exist in Safari or Firefox, and it only runs in a secure context —
`https`, or `localhost`/`127.0.0.1` as the dev server uses. To ride from a
tablet on the same network you would need to serve the app over https.

## Build phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Full UI driven by a simulated trainer and strap | **done** |
| 2 | Real Bluetooth connections (FTMS trainer, HR strap, power meter, speed/cadence) | **done** |
| 3 | Trainer control: ERG targets and free/simulation mode over BLE | **done** |
| 4 | Polish, then a backend | next |

### What phase 1 gives you

- **Workout loading** — `.zwo` (Zwift) and `.fit` workout files, by file picker
  or drag and drop, plus a built-in library of five workouts. Both parsers
  flatten repeats into a single timeline, so `IntervalsT Repeat="5"` becomes ten
  blocks and a FIT `repeatUntilStepsCmplt` step is expanded the same way. The
  library includes 3-hour and 4-hour pure free rides: no power targets at all,
  split into hour blocks so the ride auto-laps hourly. A free-ride block
  overrides ERG mode, so the trainer follows the gradient — or the loaded
  route's gradient — instead of a target.
- **Live ride view** — tiles for power, target, heart rate, cadence, speed,
  metres climbed and time. Power and heart rate show a 3-second average (the
  window is configurable) with the session and current-lap averages underneath.
  A canvas workout profile coloured by power zone carries your actual power and
  heart rate over it; the current block is highlighted, with the next block and
  a countdown.  Zwift-style text messages come from the workout file.
- **Route as a course** — a loaded `.gpx`/`.fit` route gets its elevation
  smoothed over a 30 m window, then gradient and cumulative ascent precomputed.
  The elevation profile always sits directly under the power graph, tinted by
  road gradient, showing where you are, the gradient under your wheels and how
  much you have climbed so far — live, and it keeps counting across laps of the
  route. The route map is a small panel in the corner of the graph (hideable,
  `M`) on OpenStreetMap streets by default, with a dark basemap available. In
  free mode, "Follow route" hands the course's gradient to the trainer instead
  of the slider.
- **Controls** — start/pause, finish, lap, ERG bias ±, free-mode gradient,
  block skip and ±30 s seek, click-to-seek on the graph. Space (start/pause),
  arrows (bias and seek), `L` (lap) and `M` (map) are bound.
- **A simulated rider** — a first-order leg model that chases the ERG target,
  with cadence, heart-rate lag and speed from a real power/aero/gravity model.
  The mock devices implement exactly the same `Device` interface the Bluetooth
  ones will, so nothing above them needs to change in phase 2.
- **Post-ride summary** — duration, distance, average/normalised/max power, IF,
  TSS, work, HR, cadence, climb, time in each zone, and how closely you tracked
  the target. One button writes a real `.fit` activity you can upload to Strava
  or intervals.icu. When you rode a route, every recorded second carries its
  GPS position and altitude, the file reports total ascent and start position,
  and it is tagged `virtual_activity` — so the upload draws the map and gets
  the elevation profile. An indoor ride with no route declares no position
  fields at all and stays `indoor_cycling`.
- **Devices** — managed from the Settings page; the top bar only shows live
  status chips. The simulated trainer and strap are **off by default** and
  folded away under a "Simulator" disclosure, so invented numbers can never be
  mistaken for a real sensor.

### What phase 2 added

Real sensors over Web Bluetooth, pairing from the Settings page:

- **FTMS trainers** (Fitness Machine Service) — Indoor Bike Data for power,
  cadence, speed, distance and passthrough heart rate. The app also reads the
  Fitness Machine Feature bitfield and tells you what the trainer will accept,
  so you know before phase 3 whether it does ERG, simulation or only
  resistance, and reads its supported power range.
- **Heart rate straps** (Heart Rate Service) — including 16-bit values, body
  sensor location, and skin-contact status: a reading taken with no contact is
  dropped rather than shown as a stale number.
- **Power meters** (Cycling Power Service) — power, plus cadence from crank
  revolutions and speed/distance from wheel revolutions, with the rollovers and
  coasting cases handled.
- **Speed and cadence sensors** (CSC Service) — the same, at that service's own
  1/1024 s tick rate.
- **"Pair anything…"** — for a sensor that does not advertise its services: it
  connects, enumerates what the device actually offers, and picks the right
  driver.
- **Reconnection** — a dropped link comes back on its own with backoff
  (0.7 s → 30 s) and resubscribes; a deliberate disconnect stays disconnected.
  Already-paired devices are reconnected on load where the browser can list
  them (`navigator.bluetooth.getDevices()`), and the simulator stays switched
  off whenever real hardware is known, so made-up numbers never mix into a real
  ride.
- **Source arbitration** — when two devices report the same metric, a dedicated
  sensor beats the trainer's own estimate: your strap supplies heart rate, your
  power meter supplies power, the trainer still supplies speed. The panel shows
  which device is supplying what, and values go stale after 5 s rather than
  freezing on screen.

### What phase 3 added

Trainer control over the FTMS control point (0x2AD9), so the workout drives the
brake:

- **ERG** — the workout's target, biased by the ± control, written as
  `Set Target Power` (opcode 0x05) and clamped to the range the trainer
  reported in its Supported Power Range.
- **Free / simulation mode** — the gradient from the slider, or from the loaded
  route when "Follow route" is on, written as
  `Set Indoor Bike Simulation Parameters` (opcode 0x11) with wind speed,
  gradient, rolling resistance and wind resistance coefficient.
- **Control handling** — control is requested on connect (opcode 0x00, then
  `Start or Resume`), and re-requested automatically when the trainer takes it
  back, which it announces as machine status 0xFF. Finishing a ride zeroes the
  target and sends `Stop` to release the brake.
- **A trainer that drops mid-interval** reconnects, re-requests control and is
  pushed the current target again without the rider touching anything.
- **Trainers that do not answer** their control point are ridden anyway rather
  than refusing to work; the panel says `in control (trainer does not
  acknowledge)` so the behaviour is visible rather than silent.
- **Read-only trainers** expose no control at all, so the session never tries to
  command them, and the Target tile says `no trainer control` instead of showing
  a target nothing is enforcing.

Two details that matter more than they look. Every control-point exchange is a
single slot in one queue: GATT allows one outstanding operation per device, and
splitting "request control" from "send target" let commands interleave and
deliver targets **out of order**, leaving the trainer holding a wattage the
workout had already moved past. And control is requested in the background
rather than during `connect()`, so a trainer that never acknowledges does not
hold the connection in "connecting" for seconds while its data is already
flowing.

`setResistance` is deliberately not implemented: the FTMS spec defines
`Set Target Resistance Level` as a `uint8` at 0.1 resolution, which cannot
express the 0–100 ranges trainers actually advertise, and implementations
disagree. ERG and simulation cover every trainer this app has a use for.

### What is deliberately not here yet

No Bluetooth (phase 2), no ride history or workout library persistence, no
account, no upload integrations, no calibration/spindown, no virtual-gear or
steering support.

## Layout

```
src/
  core/        event bus, formatting, power/HR zones, settings store
  workout/     workout model, .zwo parser, .fit workout parser, sample library
  fit/         FIT binary layer: CRC, profile tables, decoder, encoder
  activity/    track model, course model, GPX parser, FIT activity reader/writer
  session/     the ride engine (state machine, recorder, trainer commands), metrics
  devices/     Device/TrainerControl interfaces, hub, physics, simulated rider
  devices/ble/ Web Bluetooth: UUIDs, characteristic parsers, revolution
               trackers, GATT transport with reconnect, pairing
  ui/          app shell, ride view, power graph, elevation graph, mini map,
               summary, settings + devices
tests/         node-run suites (FIT round-trip, parsers, full app boot in jsdom)
samples/       a workout and a route to try the loaders on
```

Two seams matter for the phases ahead:

- `src/devices/types.ts` defines `Device` and `TrainerControl`. The BLE devices
  implement `Device` and register with the hub exactly as the simulated ones do;
  the session and the UI never learn where the numbers came from. `FtmsTrainer`
  implements `TrainerControl` over the FTMS control point; a Wahoo or Tacx
  adapter would implement the same two methods over its own proprietary one,
  and nothing above it would change. `FtmsTrainer.control` is a getter that
  returns `undefined` until a control point has actually been found, which is
  how a read-only trainer stays read-only.
- `src/session/session.ts` owns all trainer writes and already throttles them
  through a command queue (one write per 500 ms, latest value wins). Real BLE
  control points drop commands when flooded, so this is where that is handled
  rather than in each device.

## Testing

`npm test` bundles each `tests/*.test.ts` with esbuild and runs it in Node:

- **fit-roundtrip** — encodes an activity, reads it back with this app's own
  decoder *and* with Garmin's official `@garmin/fitsdk`, which independently
  confirms the field numbers, scaling, timestamps and CRC are right. A broken
  FIT export is otherwise invisible until an upload fails.
- **fit-workout** — writes a FIT workout with repeats and absolute-watt targets,
  has the Garmin SDK confirm the field mapping, then checks the parser expands
  it into the right timeline.
- **parsers** — every library workout, every `.zwo` block type, the edge cases
  (absolute watts, malformed XML, unknown blocks, cooldown direction), GPX with
  Garmin extensions, and the shipped sample files.
- **course** — gradient, cumulative ascent and lap wrapping against a synthetic
  route with known geometry, the gradient colour scale, and the elevation
  graph's distance/pixel mapping in both directions. That mapping is one pair of
  pure functions used by both the drawing code and the hover cursor, so the two
  cannot drift apart again.
- **ble** — every characteristic parser against hand-built packets: the
  inverted "More Data" bit, 24-bit distance fields, signed power, the
  not-available sentinel, truncated packets, a Cycling Power packet with every
  optional field set (which is what pins down the skip offsets behind it),
  16-bit heart rate, contact status, RR intervals, feature bitfields. Plus the
  revolution trackers' rollover and coasting behaviour, and the hub's source
  arbitration and staleness.
- **ftms-control** — every control-point encoder byte for byte (target power as
  a signed little-endian 16-bit field, the seven-byte simulation packet, field
  clamping), response parsing, and the control-point state machine: control
  requested once rather than once per command, concurrent commands serialised
  **and ordered**, a silent trainer still ridable, a refusal surfaced, control
  re-acquired after it is revoked, and a failed GATT write not jamming the queue.
- **erg-integration** — the whole chain in one test: a workout block's target
  becomes the right bytes on a fake trainer's control point, the bias control
  moves them, a mid-ride dropout reconnects and gets the target pushed again,
  free mode sends a gradient instead, and finishing zeroes the target and stops
  the trainer.
- **ble-device** — drives the real device classes through a fake GATT stack:
  connect, read features/battery/identity, subscribe, receive packets, lose the
  link, reconnect, receive again, take control, send ERG targets and gradients,
  lose control to the trainer and re-acquire it, disconnect deliberately. This
  is what caught
  the duplicate-listener bug: Chrome returns the *same* characteristic object
  after a reconnect, so every packet was being handled twice until listeners
  were scoped to the link with an `AbortController`.
- **mini-map** — drives the real map through Leaflet under jsdom: it follows
  the rider at close zoom, the in-map switch turns that off and is remembered,
  the overview button zooms out and stops following, and with following off the
  map stays where it was put, and it disappears again when the route is
  cleared. It also feeds a second of riding in one position per animation frame
  and asserts the map centre does not move once, while the marker does — the
  dead zone, measured.
- **app-boot** — boots the real UI in jsdom, connects the simulated devices,
  rides a workout, checks the dashboard/graph/interval bar update, exercises
  bias, mode switching and seeking, loads the sample route and checks the climb
  tile, mini map and route-following gradient, rides to the end, and verifies
  the summary and its FIT export. It also fails if anything reaches
  `console.error`.

## Credits

Route tiles © OpenStreetMap contributors, dark basemap © CARTO. FIT is a Garmin
specification; the encoder and decoder here are written from the public profile.
