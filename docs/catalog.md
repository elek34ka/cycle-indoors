# Content catalog

Workouts, routes and training plans are published as a static catalog: raw
files plus one `index.json` that describes them, on a public Cloudflare R2
bucket. There is no server. Publishing new content never needs an app deploy.

The app reads it in the **Library** tab. Live at
`https://pub-4821c98870dc4a12b6e474d06acab38a.r2.dev`.

## The `content/` folder

`content/` holds the source files. It is gitignored, so it lives only on the
machine that publishes the catalog.

```
content/
  workouts/   .zwo and .fit workouts
  routes/     .gpx and .fit routes (a .fit needs GPS records)
  plans/      one folder per training plan, holding .zwo and .fit workouts
```

- **Sub-folders become tags** in `workouts/` and `routes/`.
  `workouts/vo2/short/x.zwo` is tagged `vo2` and `short`. Plans are different:
  see below.
- **The path is the id.** That file's id is `workout:vo2/short/x`. Renaming
  or moving a file changes its id. Two files that would share an id, such as `routes/loop.gpx` and
  `routes/loop.fit`, fail the build.
- **Every file is parsed by the app's own loaders**, so what the catalog says
  (duration, TSS, distance, ascent) is what the ride will be. A file that does
  not parse, or sits in the wrong folder, is reported and left out. The rest
  still builds. Dot-files such as `.DS_Store` are ignored.
- A workout's title is its `<name>`, or the file name with `_` and `-` turned
  into spaces when it has none.
- Summaries are worked out at 100% FTP. A `.fit` workout that gives absolute
  watts rather than % FTP is summarised as if FTP were 250 W. Its duration is
  exact, but its TSS and zone times are only as right as that guess. Riding it
  is unaffected.

## Plans

A plan is a folder in `content/plans/`. There is no plan file to write: the
workouts in the folder are the plan, in order.

```
content/plans/
  GCN_Zero_to_Hero_Plan/        → plan "GCN Zero to Hero Plan"
    Intro.zwo                   1  (the folder's own files come first)
    Week_2/2_1_Endurance.zwo    2  under the heading "Week 2"
    Week_2/2_2_Tempo.zwo        3
    Week_10/Taper.zwo           4  under "Week 10", after Week 2
  Your_First_Century/           → a flat plan
    TP_FirstCentury_1_7.zwo     1
    TP_FirstCentury_2_1.zwo     2
    TP_FirstCentury_10_1.zwo    3
```

- **Order:** by sub-folder first. Within a sub-folder:
  - **When every title in the plan is numbered** (`Week 1.3 - …`,
    `Phase 2.1 - …`, `1.3 …`), by that number. Many Zwift plans number their
    titles but not their file names.
  - **Otherwise by file name.** Comparison is natural, so `_2_1` comes before
    `_10_1` and `Week_2` before `Week_10`, and case is ignored.
  - **A plan with only some numbered titles** keeps file order.
- **Titles:** plan titles and sub-folder headings show `_` as spaces.
- **Plan workouts are ordinary workouts too.** Each is listed in the Library's
  Workouts section, tagged with its plan's title, with an id such as
  `workout:plans/GCN_Zero_to_Hero_Plan/Week_2/2_1_Endurance`.
- **The sub-folder goes in front of the title** outside the plan's own
  headings, in Workouts, Up next and the summary: `Week 12 · Anaerobic #2`.
  This is skipped when the title already names its week (`Week 1.4 - …`).
- **Problems are reported, never fatal:**
  - A plan workout that does not parse is left out of its plan. Zwift plans
    contain many of these: rest days and swim or run sessions with no blocks
    at all.
  - A plan with nothing readable left is left out.
  - A file placed directly in `plans/`, such as an old `.json` plan, is
    skipped.

## Building and previewing

```sh
npm run catalog:build   # content/ → .catalog/ (gitignored); prints counts and anything left out
npm run dev:catalog     # builds, then runs the dev server reading the catalog from .catalog/
```

`catalog:build` exits non-zero only when the build fails as a whole, which
means an id collision. `dev:catalog` serves `.catalog/` at `/catalog/`
through a dev-only Vite plugin, so a catalog can be tried before it is
published.

## The bucket layout

```
index.json              cached for 60 s
files/<sha256>.<ext>    cached for a year, immutable
```

Files are stored under the SHA-256 of their bytes. An edited file gets a new
key, so a cached copy can never be stale, and the app checks each file's hash
after download as well. The index is versioned. An app that meets an index
of a newer major version says so and carries on without the catalog.

## Publishing the catalog

One-time set-up, with the same Cloudflare login as the relay:

```sh
npx wrangler login                                   # if not already
npx wrangler r2 bucket create cycle-indoors-catalog
npx wrangler r2 bucket dev-url enable cycle-indoors-catalog   # prints the public https://pub-….r2.dev URL
npx wrangler r2 bucket cors set cycle-indoors-catalog --file scripts/catalog/r2-cors.json
```

Then put the public URL in `src/catalog/config.ts` (`DEFAULT_CATALOG_URL`)
and deploy the app. The CORS rules allow GET and HEAD from the Pages site
and the dev server. Edit `scripts/catalog/r2-cors.json` and run the `cors set`
again to add an origin. The r2.dev URL is rate-limited and meant for light
use. A custom domain (`wrangler r2 bucket domain add`) is the upgrade, and
only changes that one URL.

After that, every publish is:

```sh
npm run catalog:sync -- --dry-run   # what would be uploaded and deleted; changes nothing
npm run catalog:sync
```

Sync builds first and uploads nothing if the build fails. It reads the
bucket's current `index.json` and uploads only files that index does not
list, 4 at a time. It uploads the new `index.json` only once every file it
points to is in place, then deletes the files nothing points to any more.
If an upload fails, the old index stays live and riders keep a whole
catalog. If the content has not changed, it uploads nothing. Set
`CATALOG_BUCKET` to publish to a different bucket. A `403: Forbidden` means
the bucket does not exist yet, or Wrangler's login has no R2 access
(`npx wrangler r2 bucket list` tells which).
