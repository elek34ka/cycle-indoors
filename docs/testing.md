# Testing

`npm test` bundles each `tests/*.test.ts` with esbuild and runs it in Node.

The suite is kept to what guards real riders: the trainer protocol, the files
that leave the app (FIT, GPX, Strava uploads, backups, the catalog), stored
data and its upgrades, and the ride loop. Look and feel is not tested here.
Anything a glance in the browser shows at once is left to that glance, the 3D
view most of all: the owner judges it in a real browser, so only the rules
that would break silently are kept (shared tile edges, a repeated stretch
drawn once, the drawn gradient cap, a long route staying light). When you add
a test, it should catch something a rider would otherwise only find on a
real ride or a failed upload.

## Files and trainers

- **fit-roundtrip**: Garmin's `@garmin/fitsdk` accepts an encoded activity
  and reads back its GPS track, and a ride along a climbing route totals
  the right ascent. Keep checking every new FIT field against the SDK.
- **fit-workout**: the SDK confirms a FIT workout's field numbers.
- **parsers**: every built-in workout parses, every `.zwo` block type, and GPX
  with its extensions.
- **ble**: the characteristic parsers on hand-built packets: Indoor Bike Data
  (bit 0 inverted), heart rate, cycling power, crank cadence, and the hub
  preferring a dedicated sensor over the trainer.
- **ftms-control**: control-point encoders and responses, concurrent commands
  serialised and in order, lost control re-requested, and a failed GATT write
  that surfaces without jamming the queue.
- **ble-device**: the real FTMS trainer over `fake-gatt`: connect, telemetry,
  an unexpected drop that reconnects with exactly one listener, clamped ERG
  targets, simulation parameters, and a deliberate disconnect that stays
  disconnected.
- **erg-integration**: a block's target reaches the brake, a trainer that
  drops mid-ride comes back holding the right target, and nothing is sent out
  of order.
- **background-clock**: a hidden tab's 30 s gap is ridden in full, and the
  next block's target still reaches a real FTMS stack with no frames or timers.
- **spin-down**, **calibration-session**: the spin-down state machine, and
  the session refusing it mid-ride, sending it and reporting the result.

## The ride

- **app-boot**: boots the real UI in jsdom on the simulated devices, rides a
  workout, follows the sample route, hands over to free riding when the
  workout runs out, finishes, exports a valid FIT, never loads the 3D
  renderer unasked, and logs nothing to `console.error`.
- **ride-targets**, **ride-controls**: ERG overrides, the next block ending
  them, the override recorded, free riding at a gradient, Follow route, and
  the watts field refusing what is out of range.
- **workout-navigation**: the workout clock moves only forward.
- **physics**, **virtual-speed**: speed settles where the steady-state model
  says, and on a climb the virtual speed is what the rider sees and the FIT
  records, confirmed by the SDK.
- **course**: lap wrapping, the elevation cursor pair
  (`xForDistance`/`distanceForX`), a 27k-point route binned into no more
  columns (and no more fills) than the profile has room for, and a
  200,000-point route loading at all.
- **route-geometry**: `positionAt`.
- **profile-graph**: the trailing 3 s average, heart-rate dropouts not
  averaged as zero, and the export keeping raw samples.
- **ride-render-cost**: on a still ride clock, frames and ticks repaint
  neither graph, while a new recorded second or the next block repaints the
  workout graph once; behind another tab the ride goes on and neither graph
  paints until the ride screen is back. A slow laptop is the only other
  place this shows.
- **ride-summary**, **summary-image**, **hr-zones**, **training-zones**:
  the summary's values, a route ride, time in zones against the rider's zones,
  the stats image's contents, the standard zones, which bounds are allowed,
  and saved zones checked on load.
- **wake-lock**: the screen lock is taken again on return to the tab.
- **mini-map**, **route-preview-map**: the map appears with a route, does not
  move while the rider is in its dead zone, catches up outside it, asks for
  no frames while the rider is still or the ride screen is hidden, keeps the
  rider out of the route's SVG, and goes with the route; the preview map frames a route and reports hover distance.

## Route smoother

- **smoothing**: spike removal, the gradient limits, and GPX export
  round-tripped through the app's own parser.
- **route-smoother**, **library-smoother**: loading a route, refusing a file
  that is not one, riding the smoothed route within its limit, Smooth on a
  catalog route, and the mid-ride lock.

## 3D view

- **startup-bundle**: what startup loads (the entry chunk and its static
  imports) holds no `src/scene/` module, no `route-scene-view` and no
  three.js; they are only reachable through `import()`.
- **scene-terrain-mesh**: neighbouring tiles share their edge bit for bit.
- **scene-passes**: an out-and-back climb is drawn once.
- **scene-view-profile**: a 28 % ramp is drawn at 20 % or less.
- **scene-chunks**: a 200 km route holds no more than a 20 km one.
- **route-scene-view**: the window, with a fake renderer, leaves the ride
  alone, stops drawing once paused and settled (a control change draws one
  more frame), and says so when 3D cannot be shown.
- **library-scene**: the 3D view button is hidden until the setting is on,
  and opens on a catalog route.

## Catalog and Library

- **catalog-build**, **catalog-plans**, **catalog-parity**: natural order,
  problems reported and not fatal, files under their content hash, duplicate
  ids failing the build, plan order by sub-folder or numbered titles, and the
  index agreeing with `loadFile`.
- **catalog-summary**: TSS by hand, and a route summary equal to the ride
  screen's `Course`.
- **catalog-sync**: an edit uploads, then swaps the index, then deletes; a
  failed upload leaves the old catalog; `--dry-run` never writes; a failed
  build or unreadable bucket index stops the sync.
- **catalog-index**, **catalog-client**: a newer major version is refused,
  and a reachable and an unreachable catalog.
- **library-view**, **library-filter**, **library-plans**: boot never waits on
  the catalog, Ride loads a catalog workout, nothing loads mid-ride, a hanging
  catalog blocks nothing, search, and plan progress.
- **library-db**: files kept, version 1 and 2 databases upgraded with their
  data, the ride log, and restore replacing all or nothing.
- **personal-library**, **personal-unavailable**, **absent-entries**: files
  the rider loads are kept, a FIT file that is both workout and route,
  refused storage, and entries shown after a restore.
- **done-marks**, **up-next-boot**: marking a workout after a ride, when the
  summary offers a mark, and a followed plan never holding up boot.
- **ride-log**, **my-rides**, **ride-replay**, **ride-same-session**: the
  logged numbers, My rides, and Ride same session.

## Strava and backup

- **strava-relay**: only the app's origins, the secret added on code exchange
  and refresh, an upload forwarded untouched, and only the fixed set of calls.
- **strava**: connecting, tokens refreshed without the rider, an upload, its
  outcomes, and only the relay called once connected.
- **strava-ui**: auto-upload on finish, upload permission unticked on Strava's
  page, and nothing but the approval pop-up going to strava.com.
- **backup-key**: the key as text, and every single-symbol typo and
  neighbour swap caught.
- **backup-seal**, **backup-vault-client**, **vault-worker**: a sealed round
  trip, the vault client, and the Worker's callers, one backup per key and
  its size limit.
- **backup-profile**: every setting is personal or device-only on purpose,
  and applying a profile.
- **backup**, **backup-panel**: restoring in another browser, when a restore
  cannot happen, and creating a key in the panel.
