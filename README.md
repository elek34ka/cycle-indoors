# Cycle Indoors

A browser-based indoor cycling app. Ride structured workouts with a smart
trainer in ERG or simulation mode, read power and heart rate from Bluetooth
sensors, ride a GPS route as the course, and export the ride as a `.fit`
activity or send it to Strava.

Inspired by [Auuki](https://auuki.com/) ([source](https://github.com/dvmarinoff/Auuki)).

## Running it

```sh
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # ~2300 checks, no browser needed
npm run build      # typecheck + production build into dist/
```

Pairing sensors needs Chrome, Edge or another Chromium browser. Web Bluetooth
does not exist in Safari or Firefox, and it only runs over `https` or on
`localhost`/`127.0.0.1`.

## Features

### Riding

- **Workouts** from `.zwo` (Zwift) or `.fit` files, by file picker or drag and
  drop, plus six built-in workouts and a published catalog.
- **Live ride view**: tiles for power, target, heart rate, cadence and time,
  with a workout profile coloured by power zone and your power and heart rate
  drawn over it. Block targets are shown in watts and % FTP.
- **ERG with control**: nudge the target with bias, or type exact watts for
  the current block. Free riding holds either a gradient or a power you set.
- **The workout ending does not end the ride.** It hands over to free riding
  until you press Finish.
- **The clock only moves forward.** Only next block (`▶|`) and `+30s` move it,
  so a stray tap cannot send you back.
- **Built for a long ride**: the screen is kept awake, and the ride keeps
  going in a background tab.
- **Shortcuts**: Space (start/pause), ↑/↓ (bias), `L` (lap), `M` (map),
  `W` (workout panel).
- **Your own training zones** (Settings → Edit power zones / Edit heart-rate
  zones, each a pop-up): 7 power zones and 5 heart-rate zones. Each one shows
  its range in % of FTP or max HR and in watts or bpm. They start as the standard formula (power 55/75/90/105/120/150 %
  of FTP, heart rate 60/70/80/90 % of max HR). Set any zone's upper bound in %
  and the next zone starts there. Bounds are kept as %, so a new FTP moves the
  watts with it. Reset to formula undoes your edits for one table. The ride
  screen, the summary and the Strava description use your zones; the Library
  keeps the standard ones.

### Trainer and sensors

- **FTMS smart trainers**: ERG targets and simulation (gradient) mode over the
  FTMS control point.
- **Heart rate straps, power meters and speed/cadence sensors.** When two
  devices report the same thing, a dedicated sensor beats the trainer's
  estimate.
- **Reconnects on its own** after a dropped link, and pushes the current target
  to the trainer again.
- **Spin-down calibration** for trainers that support it, from the Devices tab.
- **Bluetooth log**: with Debug tools on in Settings, you can download every
  packet exchanged, to diagnose a misbehaving trainer.
- A **simulated trainer and strap** for trying the app without hardware. They
  are off by default, so invented numbers are never mistaken for a sensor.

### Routes

- **A `.gpx` or `.fit` route becomes the course.** The elevation profile sits
  under the power graph, with live gradient and metres climbed, and the route
  shows on a draggable corner map.
- **Follow route**: while riding free, the trainer gets the road's gradient.
- **Speed from physics**: on a route, speed comes from your power, weight and
  the gradient, so climbs are ridden at climbing speed even in ERG.
- **Route smoother** (Settings, or Smooth on any Library route) takes GPS
  noise and sudden ramps out of the elevation. Choose a preset or set limits,
  compare before and after, then ride the result or download it as `.gpx`.

### Library

- **One place for everything**: built-in workouts, the published catalog and
  My library, with search and filters by duration, distance, ascent and tags.
- **My library**: every file you load is kept in the browser and listed after
  a reload.
- **Training plans**: follow one, mark workouts done, and the next undone
  workout is offered as **Up next**.

### After the ride

- **Summary**: power, NP, IF, TSS, heart rate, climb and how closely you held
  the target. The whole ride is drawn on the workout graph, with your power and
  heart rate over the blocks, and a route ride gets its elevation profile
  underneath. Separate charts show time in your power zones and heart-rate
  zones, as set in Settings.
- **Images**: Save graph image and Save stats image write PNGs of the graph
  and of every number, for sharing. Strava does not accept images from apps,
  so to put them on the activity you add them on Strava yourself.
- **`.fit` export.** A route ride carries its GPS track, so Strava draws the
  map.
- **Strava upload**, by button or automatically on finish, once connected in
  Settings. The activity's description names the route and the workout, then
  lists the summary's numbers and time in your zones. Strava's own zone
  charts on the activity use the zones in your Strava account, not these.
  A route ride goes up as a Virtual Ride with its map; a ride without a route
  as an indoor (trainer) ride. Route rides uploaded before this was fixed went
  up as trainer rides, which Strava shows without a map: edit the activity on
  strava.com and untick the indoor/trainer option to bring the map back.
  Only connecting needs `strava.com` itself to be reachable: after that,
  uploads go through the app's relay, so where Strava is blocked a VPN is
  needed for Connect and not for each upload.
- **My rides**: a log of every finished ride's numbers. **Ride same session**
  loads the same workout and route again.

### Backup

Settings → Backup stores your profile, encrypted, so you can move it to
another browser. The profile is your done marks, followed plan, personal
settings (training zones included), ride log and My library references. It is locked with a recovery
key that only you hold. **Lose the key and the backup is gone.** Restoring
**replaces** the profile on that device; it does not merge.

## What leaves the browser

Nothing, unless you send a ride to Strava or make a backup. A Strava upload
goes through the app's relay (`relay/`), which passes the `.fit` and your
Strava access token on to Strava and keeps neither. Settings are kept
in `localStorage`, and My library, done marks and the ride log in IndexedDB.
**The ride itself lives only in memory** until you download or upload it, so
reloading the page loses an unsaved ride.

## Not here yet

Ride persistence across a reload, full ride history, calendar scheduling of
plans, accounts, uploads to anything but Strava, power meter zero-offset
calibration, and virtual gears or steering.

## Layout

```
src/
  core/        event bus, formatting, power/HR zones, settings store
  workout/     workout model, .zwo parser, .fit workout parser, built-in workouts
  fit/         FIT binary layer: CRC, profile tables, decoder, encoder
  activity/    track and course model, GPX and FIT activity read/write,
               elevation smoothing, Strava client
  session/     the ride engine (state machine, recorder, trainer commands),
               metrics, spin-down calibration
  devices/     Device/TrainerControl interfaces, hub, physics, simulated rider
  devices/ble/ Web Bluetooth: parsers, GATT transport with reconnect, pairing,
               FTMS control point, Bluetooth log
  ui/          app shell, ride view, graphs, mini map, summary, settings,
               devices, route smoother, Library
  catalog/     content catalog: index format, summaries, builder, sync, client
  library/     Library entries, search and filters, the IndexedDB store
  ride-log/    the ride log's entry for a finished ride
  backup/      recovery key, encryption, the profile, the vault client
public/        copied verbatim into the build: strava-callback.html
relay/         Strava relay (tokens and forwarded API calls), a Cloudflare Worker
vault/         encrypted backup store, a Cloudflare Worker over a private R2 bucket
scripts/       test runner, catalog build/sync
tests/         Node-run suites, including full app boots in jsdom
samples/       a workout and a route to try the loaders on
```

## Extension points

- `src/devices/types.ts` defines `Device` and `TrainerControl`. Bluetooth and
  simulated devices both implement `Device`, so the session and UI never learn
  where the numbers came from. A Wahoo or Tacx adapter would implement
  `TrainerControl` over its own control point, and nothing above it would
  change.
- `src/session/session.ts` owns every trainer write and throttles them (one
  per 500 ms, latest value wins). New control paths belong there, not in the
  UI.

## Documentation

- [docs/deploy.md](docs/deploy.md): the Strava relay and the backup
  vault (what they do, and how to deploy them).
- [docs/catalog.md](docs/catalog.md): the content catalog, covering the
  `content/` layout, training plans as folders, and publishing to R2.
- [docs/testing.md](docs/testing.md): what each test suite covers.
- `openspec/specs/`: the detailed behaviour of each feature.

## Credits

Route tiles © OpenStreetMap contributors, dark basemap © CARTO. FIT is a Garmin
specification; the encoder and decoder here are written from the public profile.
