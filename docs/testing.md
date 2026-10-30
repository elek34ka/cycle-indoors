# Testing

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
  A second smoother on the same page, as the Library builds it, has no picker
  and its own ids, and shares the parameters both ways. Its figures match the
  first's for the same route, it calls back after Ride this route, and Reset
  to defaults resets it too. `load` reports whether a route is now previewed.
- **library-smoother** — Smooth on Library routes, in the booted app with a
  stand-in catalog and IndexedDB. Covered: a failed download, a hash
  mismatch and a route without elevation, each refused with the reason and
  no smoother. A catalog route fetched by its hash key shows the full
  smoother, the same figures as Settings, and no picker, while the ride's
  course stays as it was. The smoother stays open through a preset change
  (which Settings follows) and through a filter. It closes on another route,
  on a section change and on removal. A My library route opens with no
  request, and a file that arrives after the rider has moved on is dropped.
  Mid-ride, Smooth works and Ride this route is disabled even against a
  forced click. Ride this route switches to the Ride tab with the smoothed
  course and keeps nothing in My library.
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
- **background-clock** — a session with animation frames switched off and a
  clock moved by hand, standing in for a hidden tab. A 30 s gap is ridden in
  full: 30 s, 30 samples, 300 m. A block boundary inside one gap lands at the
  block's own start. A 40-minute suspension is not credited, and nor is a
  pause. Sensor packets alone move the ride, and returning to the tab shows it
  caught up at once. Over the fake GATT, with every timer held, the next
  block's 250 W target still reaches the trainer on the back of its own
  notifications.
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
- **strava** — the Strava client against a fake Strava, relay, pop-up and
  storage: the approval URL, an answer for another attempt ignored, refusal,
  an unticked upload permission, cancel and a blocked pop-up; tokens kept
  across a reload; a refresh two minutes before expiry that rotates the
  refresh token under the lock; a revoked app forgetting its tokens; the
  upload's form fields, polling, duplicate, processing error, rate limit,
  401, a slow Strava and no network; disconnect with and without Strava
  reachable. It also checks `public/strava-callback.html` uses the same
  channel.
- **strava-ui** — the Settings panel and the summary in jsdom with the real
  client, faking only the network and `window.open`: connect through the
  callback channel, auto-upload on finish with no click and no pop-up, no
  second upload on reopening, the button with auto-upload off, a duplicate, a
  failure that can be retried, Upload while disconnected connecting first,
  and an unticked permission. The ride log is written when the summary
  opens, once however often it is shown, linked to the activity after an
  upload or a duplicate, and storage that is refused never blocks the
  summary.
- **catalog-index** — the index check: a newer major version is refused as
  "needs a newer version of the app", minor versions pass, and damaged
  indexes (no version, a route without a file, an id of the wrong kind) are
  refused. Catalog URLs join with or without a trailing slash, and are
  absent when no catalog is configured.
- **catalog-summary** — workout summaries against hand calculations: a
  steady hour at 75% is TSS 56.25 and all Z2, a 50→100% ramp splits 60/240/
  180/120 s across Z1–Z4, and 30 min at 100% plus 30 min free riding is TSS
  50 with the free half in no zone. Route summaries equal the ride screen's
  `Course` for the sample route, a 2 000-point route thins to 200 evenly
  spaced points, and a Cyrillic name survives.
- **catalog-build** — the builder on files shaped like real Zwift exports
  (`pace="0"` attributes, SteadyState with PowerLow/PowerHigh): ids from
  paths, tags from folders, title fallback, a truncated XML file and a
  one-point route reported while the rest builds, wrong-folder files skipped,
  dot-files invisible, content-hash keys shared by identical bytes and
  changed by an edit, and an id collision failing the build naming both files.
- **catalog-plans** — plans as folders:
  - a flat plan ordered `1_7`, `1_10`, `2_1`, `10_1` regardless of case;
  - a plan with sub-folders: top-level files first, `Week_2` before
    `Week_10`, and nested folders as one group;
  - plan workouts as ordinary entries (id, plan tag, group, file);
  - numbered titles (`Week 1.3`) ordering a plan whose file names do not,
    with plain and half-numbered titles keeping file order;
  - the sub-folder shown in front of a title, except when the title already
    names its week;
  - totals that are the sum of the plan's workouts;
  - several plans in natural order;
  - a loose `.json`, a wrong-type file and a broken workout each reported
    without failing the build;
  - empty and unreadable plans left out;
  - a `workouts/plans/` path that clashes with a plan workout failing the
    build naming both files.
- **catalog-parity** — `.zwo`, FIT workout, `.gpx` and FIT route files built
  into an index and loaded through `loadFile` at a different FTP: duration,
  block count, distance, ascent and name agree for every one.
- **catalog-sync** — sync against a stand-in bucket that records every call:
  an empty bucket, an unchanged catalog (only the index is read), an edit
  (new file, then the index, then the old file deleted, in that order), a
  removal, cache headers on files and on the index, an upload failing midway
  (the index never written, the old one intact, nothing deleted, no new
  uploads started), a dry run that only reads, a failed build or an
  unreadable bucket index refusing to start, and a failed delete reported
  without failing the sync.
- **catalog-client** — the catalog client against a stand-in fetch: the index
  revalidated (`no-cache`), kept until a fresh load is asked for, and a file
  fetched by its key and hash-checked. Offline, a 404, a non-JSON body, a
  newer version, a damaged index and no catalog configured are each reported
  rather than thrown. A file that is tampered with, missing or unreachable
  throws with a message the rider can act on.
- **library-filter** — search over titles, authors and tags with every word
  required, the source and tag filters, inclusive and open-ended ranges, and
  when the filters count as narrowing a section. The built-in workouts as
  entries. The thumbnails' geometry: widths by duration, heights by % FTP
  against the workout's own peak, blocks meeting end to end, zone colours,
  free riding grey and low, a route's summit highest and a flat route at
  mid-height.
- **library-view** — the Library booted in the real app with a stand-in
  catalog:
  - nothing fetched at boot, and Browse library opening Workouts;
  - six built-in and two catalog workouts labelled by source;
  - a description containing markup shown as text with its line breaks;
  - blocks in watts at the current FTP;
  - search, the empty state and Clear filters, and filters restored in a new
    Library;
  - Ride on a catalog workout giving the same segments as loading the file
    directly;
  - a failed download and a hash mismatch leaving the ride's workout alone;
  - a route loaded as the course;
  - a plan's workouts in order under their headings, plan search, Ride from
    a plan, and the plan tag in Workouts listing exactly that plan's
    workouts;
  - Ride buttons disabled during a ride, even against a forced click;
  - an unreachable catalog with built-in workouts still listed and Retry
    bringing it back;
  - a catalog that never answers blocking nothing.
- **library-db** — the IndexedDB store on `fake-indexeddb`: a file added,
  the same bytes again only touching it, most-recent-first order, bytes and
  summaries intact across a new connection, touch and remove, one database
  at version 3 with `done`, `files`, `plan`, `refs` and `rides` stores, and an open that errors or
  throws (a private window) or no IndexedDB at all giving a harmless
  unavailable store. It also covers done marks with their time, a My library
  file's mark removed with it, following and replacing a plan across a new
  connection, and version 1 and 2 databases upgraded with their data kept.
  The ride log is newest first, logging a ride again replaces it but keeps
  its Strava link, and an unknown ride is never linked. A reference becomes
  a file when the same bytes are loaded, and removing it takes its mark. A
  restore replaces marks, plan, rides and My library exactly, deleting
  local-only files and keeping referenced ones with their bytes, and a
  restore that throws partway leaves every store as it was.
- **ride-log** — the ride log's entry for a finished ride: the numbers, the
  workout's and route's entry keys and titles, title only for a file not in
  the Library, nothing for a ride under a minute, and a three-hour GPS ride
  in under 1 KB with no samples or positions, and the file hash kept when
  there is one.
- **my-rides** — the My rides section in the booted app: newest first,
  named by workout, route or free ride, the numbers and a Strava link,
  Remove asking first and keeping done marks.
- **ride-replay** — finding a logged ride's workout or route: by key, by
  the file's hash after a rename or as a My library copy, a rideable copy
  over an absent one, missing, and pending while the catalog loads; and
  when Ride same session is ready.
- **ride-same-session** — My rides in the booted app over a stand-in
  catalog:
  - no files fetched for the list;
  - a clicked ride previewing its workout and route with profiles;
  - Ride same session loading both as the same Library entries;
  - a renamed catalog file found by its hash;
  - a gone route saying No route found, with the button disabled;
  - a free ride with no button;
  - a workout-only ride unloading the previous route;
  - the button disabled during a ride.
- **absent-entries** — My library entries not on this device after a
  restore: greyed with their done mark and no Ride; a different file with
  the same name added beside them; the same bytes turning one into a normal
  entry; Remove taking the reference and its mark.
- **backup-key** — the recovery key: format, round trip in any case and
  spacing, every single-symbol typo and every swap of neighbours refused,
  and the token and non-exportable AES-GCM key derived from it.
- **backup-seal** — encryption: a round trip, a fresh IV per seal, a few KB
  for 500 marks, no plaintext in the ciphertext, and any flipped byte, the
  wrong key, an unknown version or truncation failing as damaged.
- **backup-profile** — every setting classed as personal or device-only (a
  new one fails until it is), a profile holding references and never bytes,
  tokens or the key, reading back loose or foreign data safely, settings
  from an older backup getting defaults, and applying one replacing the
  database while device settings stay.
- **backup-vault-client** — the vault client against a stand-in fetch: one
  endpoint, a bearer token and nothing else in the request, no backup as
  undefined, and every failure mapped to a reason a rider can read.
- **vault-worker** — the vault Worker against an in-memory bucket and fake
  rate limiters: origins, tokens and paths refused, one backup per token
  stored under its hash, the last put winning, 256 KiB accepted and one byte
  more refused even with a lying `Content-Length`, per-IP write limits,
  delete, and storage trouble reaching the app with CORS headers.
- **backup** — backup and restore end to end through the real Worker:
  confirming a new key, Reset to defaults keeping it, restore in a second
  browser replacing its marks, rides, plan and files while its device
  settings and Strava connection stay, the last backup winning, no backup,
  a tampered backup changing nothing, delete and forget.
- **backup-panel** — the Backup panel in the booted app: create, a wrong
  confirmation uploading nothing, the restore warning with the backup's
  date and contents, Cancel, Replace and the Strava notice, delete, forget,
  entering a key, and no service configured.
- **library-plans** — plan progress: none done, the next after two, skipping
  ahead without moving Up next past an undone workout, complete, a mark for a
  workout no longer in the plan, and an empty plan never complete.
- **done-marks** — done marks and following in the booted app, over a
  stand-in IndexedDB and catalog:
  - marking from a workout's details, the Done badge, search showing which
    match is done, and the Done filter both ways;
  - a mark made in Workouts counted by its plan, a plan row marked and
    unmarked, and the filter applied to plan details;
  - following a plan, with Up next on the Workout panel and in the Plans
    section, advancing, complete, and back to the first undone workout;
  - riding Up next, then Mark as done on the summary;
  - closing the summary marks nothing;
  - a file dropped mid-ride replacing the offer, and no workout offering
    nothing;
  - switching plans keeping marks, and Stop following;
  - an unpublished plan and an unreachable catalog each explained.
- **up-next-boot** — a followed plan with a catalog that never answers: boot
  still loads the first built-in workout, Up next says it is loading, and a
  ride can start.
- **personal-library** — My library in the booted app, over a stand-in
  IndexedDB:
  - dropped files kept once with their names, bytes and summaries;
  - a broken file shown as an error and not kept;
  - persistence asked for once, and no network request at any point;
  - a FIT file with steps and GPS kept once and listed as both, and an
    indoor ride kept as neither;
  - kept entries listed and filterable as My library, and loaded at a
    changed FTP;
  - Remove asking first, Cancel keeping the entry, and Remove deleting it
    while the ride keeps its course;
  - a dropped route, once kept, known as its My library entry for the ride
    log.
- **personal-unavailable** — the same app with storage refused: the file
  still loads, the rider is told it was not kept, and the Library says My
  library is unavailable while still listing the built-in workouts. Mark as
  done is disabled with the reason, and the summary offers no mark for the
  unkept file, and My rides says the ride log is unavailable.
- **app-boot** — boots the real UI in jsdom, connects the simulated devices,
  rides a workout, checks the dashboard/graph/interval bar update, exercises
  bias, mode switching and forward-only seeking (the Jump group holds only
  `+30s` and `▶|`; arrow keys, graph clicks and block-list clicks do not move
  the clock), loads the sample route and checks the climb
  tile, mini map and route-following gradient, rides to the end, and verifies
  the summary and its FIT export. It also fails if anything reaches
  `console.error`.
