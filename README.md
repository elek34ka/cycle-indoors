# Cycle Indoors

A browser-based indoor cycling app: load a structured workout, control a smart
trainer in ERG or free mode, read heart rate and power from Bluetooth sensors,
and ride against a live workout profile. Load a `.gpx` or `.fit` route and it
becomes the course you are riding — elevation profile under the power graph,
gradient and metres climbed live, route on a hideable corner map. Recorded rides
export as a `.fit` activity.

Inspired by [Auuki](https://auuki.com/) ([source](https://github.com/dvmarinoff/Auuki)).

Frontend only — no accounts, nothing leaves the browser. Settings live in
`localStorage`; rides are kept in memory until you download them. The one
server-side piece is `relay/`, a stateless Cloudflare Worker that holds the
Strava client secret for the upload integration being built (see
[Strava token relay](#strava-token-relay)); the app does not call it yet.

## Running it

```sh
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # ~1300 checks, no browser needed
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
| 4 | Polish (spin-down calibration so far), then a backend | **current** |

### What phase 1 gives you

- **Workout loading** — `.zwo` (Zwift) and `.fit` workout files, by file picker
  or drag and drop, plus a built-in library of six workouts. Both parsers
  flatten repeats into a single timeline, so `IntervalsT Repeat="5"` becomes ten
  blocks and a FIT `repeatUntilStepsCmplt` step is expanded the same way. The
  library includes a 1-hour pure free ride with no power targets at all. A
  free-ride block
  overrides ERG mode, so the trainer follows the gradient — or the loaded
  route's gradient — instead of a target.
- **Live ride view** — five tiles: power, target, heart rate, cadence and
  elapsed time. Each shows its main value large on the left and up to two rows
  of secondary figures on the right, with the numbers large and bold so they
  read from the saddle. Power and heart rate show a 3-second average (the
  window is configurable), with the session average over the current-lap
  average beside it. Cadence carries the speed over the distance. Target
  carries the gradient being held, if any, and the block's cadence target.
  Elapsed is the timer alone, growing with its tile. Metres climbed and the
  gradient are on the elevation strip, not a tile.
  A canvas workout profile coloured by power zone carries your actual power and
  heart rate over it, averaged over the same window as the tiles so the lines do
  not jitter (the exported file keeps every raw second); the current block is highlighted, with the next block and
  a countdown.  Zwift-style text messages come from the workout file.
  Blocks are labelled in watts with the percent of FTP in brackets — a ramp as
  `180–240 W (60–80%)`, a steady block as `225 W (75%)` — in the block list and
  the interval bar, worked out from the workout's own FTP if the file sets one
  and from the FTP in Settings otherwise, so changing FTP relabels them at once.
  On the profile itself each block carries its watts (`180–240 W` on a ramp)
  wherever it is wide enough to hold them, and hovering reads out the target at
  that exact second.
- **Route as a course** — a loaded `.gpx`/`.fit` route gets its elevation
  smoothed over a 30 m window, then gradient and cumulative ascent precomputed.
  The elevation profile always sits directly under the power graph, tinted by
  road gradient, showing where you are, the gradient under your wheels and how
  much you have climbed so far — live, in large bold type above the profile so
  it reads from the saddle, and it keeps counting across laps of the route. The route map is a small panel in the corner of the graph (hideable,
  `M`) on OpenStreetMap streets by default, with a dark basemap available. Drag
  it by its title bar anywhere in the window. It stays on screen, the position
  is remembered across reloads, and double-clicking the title puts it back in
  the corner. In free mode, "Follow route" hands the course's gradient to the trainer instead
  of the slider. It is switched on whenever a route is loaded; turn it off and
  it stays off until the next route.
- **Gradient-true speed on a route** — with a route loaded, your speed, your
  position on it and the speed/distance in the exported `.fit` come from your
  power, rider + bike weight (Settings) and the gradient under the wheels, with
  inertia, in every mode. ERG holds its power target and climbs are still ridden
  at climbing speed, so segment times on the uploaded ride mean something. This
  never changes what the trainer is sent: ERG sends only the target, and free
  mode sends the slider or, with "Follow route", the route gradient (or the
  watts you chose, with Watts). Set your
  weight. It is what makes 200 W at 8% the right speed. With no route, speed
  is whatever the trainer or speed sensor reports.
- **Your own watts** — in an ERG block, a watts field next to Bias holds exactly
  what you type (25–2000 W) for the rest of that block, with no bias; the Bias
  buttons and ↑/↓ are disabled meanwhile. The next block, `▶|`, a `+30s` into
  the next block, a new workout or emptying the field (or Escape) hands back to
  the workout's target × bias. Whenever you are riding free — a FreeRide block,
  after the workout ends, an open ride or the Free toggle — a **Grade / Watts**
  switch picks between the gradient (slider or route) and a power target you
  type, starting at 60 % of FTP. The choice and the number carry over from one
  free stretch to the next. The recorded target power is whatever was held.
- **The end of a workout is not the end of the ride** — when the last block
  runs out the workout hands over to free riding: the clock keeps going, the
  trainer switches from the ERG target to the gradient, a lap is closed at the
  boundary and the graph's axis extends with a marker where the workout ended.
  The ride finishes when you say so. There is no way back into a finished
  workout.
- **Controls** — start/pause, finish, lap, ERG bias ±, free-mode gradient,
  typed watts (below), next block (`▶|`) and `+30s`. The workout clock only moves forward: there is
  no previous block or −30 s, and clicking the graph or a block in the list
  does not jump, so a stray tap mid-ride cannot send you back. Space
  (start/pause), ↑/↓ (bias), `L` (lap), `M` (map) and `W` (workout panel) are
  bound. The **◀ Panel** button in the top bar, next to Ride and Settings, or `W`, folds
  the left Workout/Route panel away so the ride gets the full width. The choice
  is remembered.
- **The screen stays on** — while the app's tab is visible it holds a Screen
  Wake Lock, so a long block where you never touch the computer does not end
  with the display, or the PC, going to sleep. Switch tabs and the browser
  releases it, and it is taken again when you come back. Closing the lid or an
  OS power policy can still override it. Browsers without the API simply do
  without. On a finished ride
  the start button reads **Start new ride** and asks before discarding a ride
  that has not been downloaded — once you have saved the `.fit`, it stops
  asking.
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
- **Devices** — managed from their own **Devices** tab, between Ride and
  Settings; the top bar shows live status chips, and a **No trainer** or **No HR**
  chip opens the same Bluetooth chooser as the matching Pair button. The simulated trainer and strap are **off by default** and
  folded away under a "Simulator" disclosure, so invented numbers can never be
  mistaken for a real sensor.

### What phase 2 added

Real sensors over Web Bluetooth, pairing from the Devices tab:

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

- **ERG** — the workout's target, biased by the ± control, or the watts typed
  for the block or for free riding, written as
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

### What phase 4 added

**Spin-down calibration.** A trainer that advertises spin-down support (Fitness
Machine Feature, target-setting bit 15) and has a control point gets a
**Calibrate** button on its row on the Devices tab. The simulated trainer
never offers it: there is nothing real to calibrate.

- Pressing it sends `Spin Down Control` (opcode 0x13, parameter 0x01) through
  the same single control-point queue as every other command. If the trainer's
  answer carries a target speed window, the row asks the rider to speed up past
  the high target and shows the window next to the live speed. Without one, it
  asks the rider to speed up until told to stop.
- The trainer's spin-down status (machine status 0x14) drives the rest:
  "stop pedalling" (0x04) switches the row to coasting, and success (0x02) or
  error (0x03) end it. The result stays on the row until dismissed.
- **Cancel** sends parameter 0x02 (ignore). A spin-down ends as failed if the
  trainer has reported no result after 90 seconds, if it disconnects, or if it
  takes control back (0xFF).
- It is setup-only. The button is disabled while a ride is running or paused,
  and while a spin-down runs, Start is refused with a message, so no ERG or
  simulation target can land in the middle of it. The session owns all of
  this, as it owns every other trainer write.
- A spin-down takes the trainer out of its controlled, started state, often
  without a 0xFF to say so. However it ends, the next target therefore
  re-requests control and sends Start/Resume (0x07) first. The same applies
  after the app sends Stop or Reset, and after the trainer reports a reset
  (0x01) or a stop (0x02). Without this, a ride after calibrating or after
  Finish sent targets the trainer acknowledged but did not hold. Pause does
  not repeat the handshake.

Like the rest of the BLE code, this has been tested against a fake GATT stack.
The one real trainer it has met is a Van Rysel D500, which reported success
but held ERG at about 0.42× the target afterwards, until power-cycled.

**Bluetooth log.** With **Debug tools** switched on in Settings, the Devices
tab shows a **Download Bluetooth log** button. Only then is anything
recorded: bike data alone arrives several times a second, so with debug mode
off nothing is logged or decoded. Switching it off also empties the log. To
capture a problem, turn debug mode on first, then reproduce it. While it is
on, the app keeps, in memory, every control-point write, every control-point
response, every machine status and every Indoor Bike Data packet (and the other
sensors' notifications). Each entry is timestamped, tagged with the device,
and carries the raw bytes plus a short decoding. The buffer holds the last
20 000 entries. The file is plain text, one line per entry. It never leaves the
computer unless the rider shares it, and it is gone when the page is reloaded.
It exists so that a trainer that misbehaves can be diagnosed from what it
actually said.

**Route smoother.** Settings → Route smoother takes the jitter and the
sudden ramps out of a route's elevation. Raw GPS altitude turns into a
gradient that jumps every few metres, and in simulation mode the trainer's
brake follows every jump. Load a `.gpx`, or a `.fit` ride with GPS records,
into the panel. It is the smoother's own copy, so the route you are riding does
not change until you ask. The panel then:

- **resamples** the elevation at an even spacing (10 m by default), so every
  window and limit means metres of road, not GPS points;
- **removes spikes**: a reading far outside the road's height within 50 m
  either side is replaced by that stretch's median before anything is
  averaged;
- **smooths** over an odd number of points with a Savitzky–Golay filter,
  which keeps summits and valleys at their real height where a plain average
  would flatten them;
- **caps the gradient** to the min/max you set, and **limits how fast it may
  change** (percentage points per 10 m). That second limit is what stops a
  climb from kicking in all at once;
- **keeps the start and finish heights**, so a capped climb still gets you to
  the top. If the limits are too tight to reach the finish, it says so and by
  how much.

**Light**, **Medium** (the default) and **Strong** set all of these at once,
and an Advanced section exposes each one. Light (9-point window, ±15 %) only
takes off the jitter; Medium (15 points, ±12 %, 0.5 per 10 m) also softens the
ramps; Strong (25 points, ±8 %, 0.3 per 10 m) flattens everything into long,
gentle grades. Editing a field switches the preset to Custom, and the values
are remembered. Saved values are labelled by the preset they match, so a setup
saved before the presets moved keeps its numbers and shows whichever name now
fits them, or Custom. Two charts compare the original
(thin grey) with the result (blue): elevation, then gradient, with the
gradient limits dashed. Hovering either chart reads both out at that point.
Under them a map shows where the route goes. The line is coloured by the
smoothed gradient, on the same scale as the elevation chart's fill, with the
start in green and the finish in red. Hovering a chart puts a marker on the
map at that distance, and hovering the line on the map moves the charts'
cursor and the readout to the nearest point on the route. A new route is
framed whole, and changing the smoothing only recolours the line, leaving the
map where you panned and zoomed it. Leaflet and the map tiles are fetched only
once a route is loaded. Offline, the map says it is unavailable and
everything else carries on.
A table gives ascent, descent, steepest climb and descent, largest gradient
change and the start/finish shift, before and after. **Download smoothed
.gpx** writes every original point at its original position with the
smoothed height, and no times or sensor data, because it is a course and not a
ride. **Ride this route** makes it the ride's course straight away. It is
unavailable while a ride is running or paused.

### What is deliberately not here yet

No ride history or workout library persistence, no
account, no upload integrations (the Strava relay is deployed; the app side is
not built), no power meter zero-offset calibration, no
virtual-gear or steering support.

## Layout

```
src/
  core/        event bus, formatting, power/HR zones, settings store
  workout/     workout model, .zwo parser, .fit workout parser, sample library
  fit/         FIT binary layer: CRC, profile tables, decoder, encoder
  activity/    track model, course model, GPX parser and writer, FIT activity
               reader/writer, elevation smoothing, route geometry for the
               smoother's map
  session/     the ride engine (state machine, recorder, trainer commands), metrics,
               spin-down calibration state
  devices/     Device/TrainerControl interfaces, hub, physics, simulated rider
  devices/ble/ Web Bluetooth: UUIDs, characteristic parsers, revolution
               trackers, GATT transport with reconnect, pairing
  ui/          app shell, ride view, power graph, elevation graph, mini map,
               summary, settings + devices, route smoother
relay/        Strava token relay — a Cloudflare Worker, deployed on its own
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

## Strava token relay

Strava's OAuth token exchange and every token refresh require the app's client
secret, and Strava offers no PKCE or other flow for browser-only apps — so a
static site cannot connect to Strava on its own. `relay/src/index.ts` is the
smallest thing that fixes that: a Cloudflare Worker (free plan) that adds the
secret to those two calls and nothing else.

```
browser ── {code} or {refresh_token} ──▶ relay ── + client_secret ──▶ strava.com/oauth/token
browser ◀── access_token, refresh_token, expires_at, scope ──────────────────┘
browser ── POST /api/v3/uploads (Bearer token, .fit) ─────────────────────▶ Strava, direct
```

- **Stateless.** No storage, no logs of request bodies. The athlete profile in
  Strava's reply is dropped; only the tokens, expiry and scope come back.
- **Ride files never pass through it.** Strava's API sends
  `Access-Control-Allow-Origin: *`, so the browser uploads directly.
- **Origin allow-list** (`APP_ORIGINS` in `relay/wrangler.toml`): the Pages
  site and the dev server. It stops other sites' pages from using the relay
  through a visitor's browser; it is not access control, and does not need to
  be — a code is only useful for this app's own client id.
- Bad input is a 400 before Strava is contacted, Strava's own errors are passed
  through with its status, and an unreachable Strava is a 502.

Live at `https://cycle-indoors-strava-relay.elek34ka-cycle-indoors.workers.dev`
for Strava app `290716`, whose **Authorization Callback Domain** is
`elek34ka.github.io` (`localhost` and `127.0.0.1` are always allowed, so the
dev server needs nothing extra).

### Deploying it

The secret never goes in the repo: in production it is a Worker secret, and
locally it lives in the gitignored `relay/.dev.vars`.

```sh
cd relay
npm install                                    # wrangler, kept out of the app's dependencies
npx wrangler login
npx wrangler secret put STRAVA_CLIENT_SECRET   # paste at the hidden prompt
npm run deploy

cp .dev.vars.example .dev.vars                 # then paste the secret; for `npm run dev` on :8787
```

A freshly created `workers.dev` subdomain fails TLS for a few minutes while its
certificate is issued. To check a deploy, a made-up code must come back as
Strava's own `400 … AuthorizationCode invalid`:

```sh
curl -X POST https://cycle-indoors-strava-relay.elek34ka-cycle-indoors.workers.dev \
     -H "Origin: http://127.0.0.1:5173" -H "content-type: application/json" \
     -d '{"code":"nope"}'
```

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
  graph's distance/pixel mapping in both directions. The rendered elevation
  readout is checked to be 24 px and bold, to end above the plotted profile,
  and to leave the axis and hover text at their own sizes. That mapping is one pair of
  pure functions used by both the drawing code and the hover cursor, so the two
  cannot drift apart again.
- **smoothing** — the route smoother's pipeline on known profiles: a single
  40 m altitude spike and a 30 m run of them leave a flat road within 0.5 m,
  while a real 10% climb and ±1 m of noise are left alone. Savitzky–Golay
  passes lines and parabolas through exactly, ends included, and keeps a
  summit within 1 m where a moving average loses more. A 30% wall stays under
  a 15% cap, 0% to 10% takes at least 100 m at 1 point per 10 m, a clipped
  300 m climb still finishes at its height, and a 200 m climb in 2 km at 5%
  reports a 95 m shortfall. Then 200 random noisy routes × three presets are
  checked segment by segment against both limits and both anchors. The GPX
  export of the sample route, of a `.fit` ride and of an awkwardly named
  route is loaded back with the app's own parser: same points, same
  coordinates, same distance, smoothed heights within 0.1 m, no times or
  sensor data. Older settings get Medium.
- **route-smoother** — the Settings panel in jsdom: a route dropped on it
  fills the table without touching the ride's course, and a workout or an
  elevation-less GPX is refused while the previous route stays. Presets fill
  the fields, an edit switches to Custom, 8 becomes 9, and min ≥ max or an
  out-of-range value is refused and put back. The preview obeys a custom cap,
  and hovering either chart reads out both profiles at the same distance. The
  download is named `…-smoothed.gpx`, is `application/gpx+xml` and carries
  the smoothed heights. Ride this route is disabled while running or paused,
  even against a forced click. After Finish it swaps in a course that stays
  within the cap. Before a route there is no map and Leaflet is not loaded.
  After one, the map frames the whole route, keeps its view through a refused
  file and a preset change while recolouring the line, puts a marker where a
  chart is hovered, and fills the readout when its line is hovered.
- **route-geometry** — the pure helpers behind the smoother's map: a position
  at a distance clamps and interpolates, the nearest distance to a point maps
  50 places on the sample route back to themselves within 1 m and a point
  20 m off a road to its foot, and the gradient-coloured runs on a flat, climb,
  flat road come out as exactly three that join end to end, with no point lost
  on the sample route.
- **route-preview-map** — the smoother's map component through Leaflet under
  jsdom: no Leaflet until a route is set, the route framed whole, a recolour
  that keeps a hand-set view, the hover marker, a line hover near 5 km
  reporting 5 km, the tile-error notice, and a failed Leaflet load that shows
  "Map unavailable" without anything throwing.
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
  After Stop or Reset the next target is preceded by Request Control and Start
  again; after Pause it is not. Also the spin-down packet, its target speed window, and a command resolving
  with its own response even when queued behind another.
- **erg-integration** — the whole chain in one test: a workout block's target
  becomes the right bytes on a fake trainer's control point, the bias control
  moves them, a mid-ride dropout reconnects and gets the target pushed again,
  free mode sends a gradient instead, and finishing zeroes the target and stops
  the trainer.
- **ble-device** — drives the real device classes through a fake GATT stack:
  connect, read features/battery/identity, subscribe, receive packets, lose the
  link, reconnect, receive again, take control, send ERG targets and gradients,
  lose control to the trainer and re-acquire it, disconnect deliberately. A
  trainer advertising spin-down offers it, and one that does not, does not.
  A 120 W target lands in the Bluetooth log as the write `05 78 00` and then the
  decoded response `80 05 01`. A machine status and a bike data packet each log
  one decoded entry.
  Spin-down status packets arrive as signals, once each, even after a
  reconnect. A machine status of reset or stopped, or a spin-down result, makes
  the next target re-request control and Start. This
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
- **physics** and **virtual-speed** — the inertia model settles where the
  steady-state power equation says, is slower up and faster down, coasts to a
  stop and never goes negative. Then a session on a 10% climb with a trainer
  insisting on a flat 35 km/h rides at climbing speed in ERG and on the free-mode
  slider alike, and hands speed back to the trainer when the route is removed.
  The exported ride is checked with `@garmin/fitsdk`: record speeds are the
  virtual speed and distance is its integral.
- **profile-graph** — the trace's trailing average (a one-second 500 W spike
  draws at 300 W, heart-rate gaps are not averaged in as zero), while the
  exported `.fit` keeps the raw 500 W. Block labels are placed by a pure
  function below a ramp's top edge across the label's full width, and the
  rendered graph is checked to draw a 100–120 W and a steep 120–360 W ramp label
  on the block's colour rather than at the height of its high end, where it
  used to be invisible.
- **workout-navigation** — the workout clock only moves forward: `+30s` and
  next block advance it, a backward seek is refused, `+30s` at 59:50 of an
  hour stops on 60:00, and once the workout has run out neither control moves
  the clock (next block from the last block would otherwise step back to the end).
- **wake-lock** — the screen lock is taken on start, not stacked, not requested
  while hidden, re-taken on return, and a refusal is only a warning.
- **sidebar** — a sidebar folded away before a reload starts folded.
- **spin-down** — every transition of the pure spin-down state machine,
  including a status that overtakes its response and a late status that must
  not overturn a result, and the text the trainer row shows for each step.
- **calibration-session** — the session against a fake spin-down trainer.
  Calibration is refused mid-ride. Start is refused mid-calibration, with zero
  target writes reaching the trainer. It covers success, cancel (which sends
  ignore), the 90 s timeout and a mid-spin-down disconnect, and checks that a
  ride starts normally afterwards. After a successful, cancelled or timed-out
  spin-down, and on a second ride after Finish, the first ERG target is
  preceded by Request Control and Start. Pause and resume send only targets.
- **calibration-panel** — the devices panel in jsdom: no Calibrate for the
  simulator or for a trainer without bit 15, disabled during a ride, and the
  guided steps, result and Dismiss. In debug mode, Download Bluetooth log hands
  the browser a `.txt` file holding exactly the logged lines, including the run's
  control traffic. Switching debug mode off hides it and empties the log.
- **ble-log** — the Bluetooth log on its own: order kept, bytes as hex from
  either a `Uint8Array` or a `DataView`, characteristics named, the oldest
  dropped past the limit, and an empty log that says so. A switched-off log
  records nothing and gives its memory back.
- **strava-relay** — the Worker against a stand-in Strava: unlisted or missing
  origins, `GET` and malformed bodies are refused without reaching Strava; a
  code exchange and a refresh each carry the client id and secret with the
  right grant type; the reply keeps the tokens, expiry and scope, drops the
  athlete and never echoes the secret; Strava's errors and an unreachable
  Strava reach the app with CORS headers intact.
- **app-boot** — boots the real UI in jsdom, connects the simulated devices,
  rides a workout, checks the dashboard/graph/interval bar update, exercises
  bias, mode switching and forward-only seeking (the Jump group holds only
  `+30s` and `▶|`; arrow keys, graph clicks and block-list clicks do not move
  the clock), loads the sample route and checks the climb
  tile, mini map and route-following gradient, rides to the end, and verifies
  the summary and its FIT export. It also fails if anything reaches
  `console.error`.

## Credits

Route tiles © OpenStreetMap contributors, dark basemap © CARTO. FIT is a Garmin
specification; the encoder and decoder here are written from the public profile.
