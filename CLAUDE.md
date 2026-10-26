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
npm run catalog:build             # content/ → .catalog/, no upload
npm run catalog:sync -- --dry-run # what a publish to R2 would do; real sync drops the flag
```

`content/` (the owner's raw workouts/routes/plans) and `.catalog/` are
gitignored. Never commit either, and never sync to R2 without being asked: it
publishes to the owner's public bucket.

The dev server is sometimes left running detached from a previous session.
`lsof -ti:5173 | xargs kill` stops it.

## Build phases

1. UI on a simulated trainer — **done**
2. Real Web Bluetooth connections — **done**
3. FTMS trainer control (ERG + simulation) — **done**
4. Polish, then a backend — **current**

Strava upload is built (Settings panel, summary button, opt-in auto-upload) —
deliberately without persistence, at the owner's choice. In progress: the
content catalog and Library (OpenSpec change `add-content-catalog`). Its
phases are all built: the catalog, its R2 publishing, the Library tab, My
library (IndexedDB), plans as folders, done marks and following a plan.
Integration checks remain. After that: ride persistence (a
reload still destroys an in-progress or not-yet-uploaded ride), then ride
history.

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
- The Strava relay (`relay/src/index.ts`) and client (`src/activity/strava.ts`)
  are tested against stand-in `fetch`es; Strava itself is never called. The
  real flow has been checked by hand only up to the relay's code exchange.
- Every test file runs in one Node process, so globals leak between them:
  `dom-setup.ts` installs jsdom's `Blob`, which Node's `FormData` rejects. The
  Strava tests put Node's `Blob` back.
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

- **Strava's consent page lets the rider untick "upload activities"** and
  still sends a code. Check the granted scope before exchanging it; Strava
  reports scopes comma-separated in the redirect and space-separated in the
  token reply.
- **Strava refresh tokens rotate**, and the old one dies at once. Every
  refresh goes through `exclusive` (a Web Lock) and re-reads storage first,
  or two tabs refreshing together log the rider out.
- **The catalog is built with the app's own parsers**, through `loadFile`, in
  Node with jsdom's `DOMParser` (`scripts/catalog/main.ts`). Do not add a
  Node-side XML parser for speed: the index's duration/TSS/ascent would drift
  from what the ride shows. `tests/catalog-parity.test.ts` guards this.
- **Catalog files are keyed by content hash** (`files/<sha256>.<ext>`), and
  sync uploads `index.json` *after* every file and deletes *after* the index.
  Reordering either lets riders fetch an index that points at missing files.
  Sync's diff is against the bucket's own index; files orphaned by a failed
  run are never listed there and so are never cleaned up (harmless).
- **A plan is a folder, ordered at build time** (`sortPlan` in
  `src/catalog/build.ts`): by sub-folder, then by the titles' `N.M` sequence
  when *every* title in the plan has one, else by file name, all in natural
  order. Both cases occur in the owner's plans; check the real `content/`
  before changing the rule. The order is fixed in the index. Never sort plan workouts again in the app, and
  never sort ids with plain `<`: `_10_` would land before `_2_`. Many Zwift
  plan files (rest days, swims, runs) have no blocks and are reported as
  problems on every build; that is expected, not a regression.
- **`import.meta.env` does not exist outside Vite**: code under `src/` that
  the suite or the catalog script imports must read it as
  `import.meta.env?.X` (see `src/catalog/config.ts`).
- **One IndexedDB database, `cycle-indoors`** (`src/library/db.ts`), now at
  version 3: `files` (My library, keyed by SHA-256), `plan` (the followed
  plan), `done` (done marks, keyed by Library entry key), `rides` (the ride
  log, keyed by start time) and `refs` (My library files known from a
  restored backup but not on this device, keyed by SHA-256). Versions 1 and
  2 are in real browsers; the upgrade handler only creates missing stores,
  so it keeps their data. A new feature that needs storage, such as ride
  persistence, bumps `DB_VERSION` and adds its stores in the upgrade
  handler; it must not open a second database.
- **Done marks are keyed by Library entry** (`catalog:workout:<path>`,
  `builtin:<id>`, `mine:<sha256>`), not by file hash, so renaming a catalog
  file resets its mark. The summary learns which entry was ridden from
  `src/library/loaded.ts`, a `WeakMap` keyed by the parsed `Workout`: any
  new load replaces the session's workout object, so never copy or rebuild
  a `Workout` between loading and finishing, or the offer silently
  disappears. The store never rejects on
  open: a refused browser gets `UNAVAILABLE_STORE`, and the UI says so.
  Tests use `fake-indexeddb`'s `IDBFactory` passed in explicitly, never its
  `auto` import, which would leak a global into every later test file.
- **Backups are a profile of references, never bytes** (`src/backup/`). A
  backup holds done marks, the followed plan, personal settings, the ride
  log and My library as `StoredRef`s (no `bytes`). Never add Strava tokens:
  they rotate, and a restored copy would log the other browser out. Never
  add the recovery key either.
- **Restore is a full replace in one transaction** (`replaceProfile` in
  `db.ts`), never a merge, at the owner's choice. It deletes My library
  files the backup does not reference. The transaction aborts explicitly
  on any error, because a put that throws would otherwise let the writes
  before it commit. Backing up is just as blunt: the vault's `PUT` has no
  preconditions, so the last backup wins.
- **Settings are personal or device-only** (`DEVICE_SETTINGS` in
  `settings.ts`). `tests/backup-profile.test.ts` lists every key, so a new
  setting fails the suite until it is put on one side on purpose.
- **The recovery key's check symbols are a weighted sum mod 1021, not a
  hash.** That guarantees every single-symbol typo and every swap of
  neighbours is caught; a 10-bit hash let about one in a thousand through.
  The suite tries them all.
- **The vault bucket (`cycle-indoors-vault`) is private and separate from
  the public catalog bucket.** Never point the vault at the catalog bucket,
  and never give it r2.dev access. `vault/` is a separate Worker from
  `relay/`, which stays stateless.
- **Reading from an R2 bucket that does not exist returns `403: Forbidden`**,
  not a 404 (confirmed 2026-10-25: the same login read fine once the bucket
  was created). A 403 can also mean a login without R2 access. A missing *object* is "The
  specified key does not exist." — the sync treats only that as an empty
  bucket.

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
- Strava approval opens in a **pop-up, not a redirect**, so the in-memory ride
  is never navigated away from, and the callback reports over a
  `BroadcastChannel`, not `window.opener`, which a COOP header would sever.
  Auto-upload never opens the pop-up itself.
- Strava tokens are in their own `localStorage` key, **not in settings**, so
  "Reset to defaults" does not disconnect.
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
- `src/catalog/` — the content catalog. `build.ts` is pure (files in, index
  + hashed files out) and `sync.ts` takes a `BucketRunner`, so both run in
  the suite; only `scripts/catalog/main.ts` touches the disk and Wrangler.
  `summary.ts` is meant for the browser too (My library), so a file reads the
  same wherever it is listed.
- `relay/` — the Strava token relay (Cloudflare Worker), already deployed and
  verified with a real authorization code; `src/activity/strava.ts` is its
  only caller. Strava requires `client_secret` for
  the code exchange *and* every refresh (access tokens last 6 h, refresh tokens
  rotate) and has no PKCE, so this is not optional. It only ever handles
  tokens; the browser uploads to Strava directly. Never put the secret
  anywhere but `wrangler secret put` or the gitignored `relay/.dev.vars`.
  Strava's API base moves to `https://api-v3.strava.com` from 2027-01-04.
