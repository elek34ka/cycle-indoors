import { setupDom } from './dom-setup';
const dom = setupDom();

const { check, report, suite } = await import('./harness');
const { bootApp } = await import('../src/ui/app');
const { session } = await import('../src/session/session');
const { settings } = await import('../src/core/settings');
const { courseStore } = await import('../src/activity/course-store');
const { buildCatalog } = await import('../src/catalog/build');
const { CatalogClient } = await import('../src/catalog/client');
const { NO_FILTERS } = await import('../src/library/filter');
const { LibraryView } = await import('../src/ui/library-view');
const { loadFile } = await import('../src/loaders');
const { hideSummary } = await import('../src/ui/summary');
const { LIBRARY } = await import('../src/workout/library');
const { readFileSync } = await import('node:fs');
const { routeEntryFor } = await import('../src/library/loaded');
const { parseGpx } = await import('../src/activity/gpx');
type Workout = import('../src/workout/types').Workout;

const doc = dom.window.document;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => wait(40);
const enc = (s: string) => new TextEncoder().encode(s);

// Earlier suites share the session and settings singletons.
if (session.snapshot.state === 'running' || session.snapshot.state === 'paused') session.finish();
settings.patch({ libraryFilters: NO_FILTERS, librarySection: 'routes' });

const FORTY = enc(`<workout_file><author>M.De Jode</author><name>The Famous 40/20's</name>
  <description>A classic. &lt;b&gt;Bold&lt;/b&gt; claims &amp; a link: http://example.com

Second paragraph.</description><workout>
  <Warmup Duration="600" PowerLow="0.25" PowerHigh="0.72" pace="0"/>
  <IntervalsT Repeat="12" OnDuration="40" OffDuration="20" OnPower="1.2045" OffPower="0.55" pace="0"/>
  <Cooldown Duration="600" PowerLow="0.55" PowerHigh="0.25" pace="0"/></workout></workout_file>`);
const STEPS = enc(`<workout_file><name>5. Russian Steps</name><workout>
  <Warmup Duration="600" PowerLow="0.4" PowerHigh="0.4"></Warmup>
  <SteadyState Duration="15" PowerLow="0.6" PowerHigh="0.6"></SteadyState></workout></workout_file>`);

const step = (name: string, seconds: number) =>
  enc(`<workout_file><name>${name}</name><workout><SteadyState Duration="${seconds}" Power="0.65"/></workout></workout_file>`);
const build = await buildCatalog([
  { path: 'workouts/vo2/The_Famous_40_20_s.zwo', bytes: FORTY },
  { path: 'workouts/WO5_Russian_Steps.zwo', bytes: STEPS },
  // one block at 77 % of FTP: Z3 by the standard zones, Z2 for a rider whose Z2 ends at 78 %
  { path: 'workouts/Steady_77.zwo', bytes: enc('<workout_file><name>Steady 77</name><workout><SteadyState Duration="600" Power="0.77"/></workout></workout_file>') },
  { path: 'routes/georgia/sample-hilly-loop.gpx', bytes: new Uint8Array(readFileSync('samples/sample-hilly-loop.gpx')) },
  // A plan in the shape of the owner's folders: sub-folders, numbers in names.
  { path: 'plans/Base_Builder/Week_10/Taper.zwo', bytes: step('Taper', 1200) },
  { path: 'plans/Base_Builder/Week_2/2_2_Tempo.zwo', bytes: step('Tempo', 2400) },
  { path: 'plans/Base_Builder/Week_2/2_1_Endurance.zwo', bytes: step('Long endurance', 3600) },
  { path: 'plans/Base_Builder/Intro.zwo', bytes: step('Intro ride', 1800) },
]);
/** three standalone workouts plus the plan's four */
const CATALOG_WORKOUTS = 7;
const BASE = 'https://pub-test.r2.dev';
const objects = new Map<string, Uint8Array>([
  [`${BASE}/index.json`, enc(JSON.stringify(build.index))],
  ...build.files.map((f) => [`${BASE}/${f.key}`, f.bytes] as [string, Uint8Array]),
]);

/** The stand-in network: switchable failures, and a log of every request. */
const net = {
  calls: [] as string[],
  indexDown: false,
  indexHangs: false,
  filesDown: false,
  corrupt: undefined as string | undefined,
};
const fetchFn = async (url: string) => {
  net.calls.push(url);
  if (url.endsWith('index.json') && net.indexHangs) return new Promise<Response>(() => {});
  if (url.endsWith('index.json') && net.indexDown) throw new TypeError('Failed to fetch');
  if (!url.endsWith('index.json') && net.filesDown) throw new TypeError('Failed to fetch');
  if (net.corrupt && url.endsWith(net.corrupt)) return new Response('tampered');
  const body = objects.get(url);
  return body ? new Response(body as BlobPart) : new Response('missing', { status: 404 });
};
const client = new CatalogClient(BASE, fetchFn);

let lastWorkout: Workout | undefined;
session.on('workout', (w) => { lastWorkout = w; });

bootApp({ catalog: client });

const tab = (name: string) => doc.querySelector<HTMLButtonElement>(`#tabs [data-tab="${name}"]`)!;
const active = (name: string) => doc.querySelector(`#view-${name}`)?.classList.contains('active') === true;
const rows = () => Array.from(doc.querySelectorAll<HTMLElement>('#library-root .lib-list .lib-item'));
const row = (key: string) => doc.querySelector<HTMLElement>(`#library-root .lib-item[data-key="${key}"]`)!;
const titles = () => rows().map((r) => r.querySelector('.lib-title')?.textContent ?? '');
const filter = (name: string) => doc.querySelector<HTMLInputElement & HTMLSelectElement>(`#library-root [data-filter="${name}"]`)!;
const type = (input: HTMLInputElement, text: string) => {
  input.value = text;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
};
const lastToast = () => Array.from(doc.querySelectorAll('#toasts .toast')).pop()?.textContent ?? '';
const workoutTitle = () => doc.querySelector('#workout-meta h3')?.textContent ?? '';
const section = (name: string) => doc.querySelector<HTMLButtonElement>(`#library-root .lib-sections [data-section="${name}"]`)!;

suite('boot never waits on the catalog', () => {
  check('nothing is fetched at boot', net.calls.length === 0, net.calls.join(', '));
  check('the ride screen has the first built-in workout', workoutTitle() === 'Quick test', workoutTitle());
  const order = Array.from(doc.querySelectorAll('#tabs button')).map((b) => b.textContent).join(', ');
  check('a Library tab between Ride and Devices', order === 'Ride, Library, Devices, Settings', order);
});

doc.querySelector<HTMLButtonElement>('#browse-library')!.click();
await settle();

const fortyEntry = build.index.workouts.find((w) => w.id === 'workout:vo2/The_Famous_40_20_s')!;
row(fortyEntry.id.replace(/^/, 'catalog:')).querySelector<HTMLButtonElement>('.lib-ride')!.click();
await settle();
const fromCatalog = lastWorkout!;
const fromFile = (await loadFile(new File([FORTY as BlobPart], 'The_Famous_40_20_s.zwo'), { ftp: settings.current.ftp })).workout!;

suite('Ride loads a catalog workout and switches to the ride', () => {
  check('its file was fetched by its hash key', net.calls.some((c) => c.endsWith(fortyEntry.file.key)));
  check('the Ride view is shown', active('ride') && !active('library'));
  check('the workout is loaded', workoutTitle() === "The Famous 40/20's", workoutTitle());
  check('its duration matches the Library', fromCatalog.duration === fortyEntry.duration);
  check('it is the same workout as loading the file directly',
    JSON.stringify(fromCatalog.segments) === JSON.stringify(fromFile.segments) && fromCatalog.name === fromFile.name);
});

tab('library').click();
await settle();
section('workouts').click();
const titleBeforeRide = workoutTitle();
session.start();
await settle();
const lockedButtons = rows().map((r) => r.querySelector<HTMLButtonElement>('.lib-ride')!);
const notice = doc.querySelector<HTMLElement>('#library-root .lib-notice')!;
const lockedState = { disabled: lockedButtons.every((b) => b.disabled), notice: !notice.hidden && /in progress/.test(notice.textContent ?? '') };
lockedButtons[0].disabled = false;
lockedButtons[0].click(); // a forced click
await settle();
const titleDuringRide = workoutTitle();
session.finish();
hideSummary();
await settle();

suite('no loading while a ride is running', () => {
  check('every Ride button disabled', lockedState.disabled);
  check('the Library says a ride is in progress', lockedState.notice);
  check('a forced click loads nothing', titleDuringRide === titleBeforeRide, `${titleBeforeRide} → ${titleDuringRide}`);
  check('after Finish they work again', rows().every((r) => !r.querySelector<HTMLButtonElement>('.lib-ride')!.disabled) && notice.hidden);
});

net.indexHangs = true;
tab('ride').click();
tab('library').click();
await settle();
const hanging = doc.querySelector('#library-root .lib-status')?.textContent ?? '';
row(`builtin:${LIBRARY[1].id}`).querySelector<HTMLButtonElement>('.lib-ride')!.click();

suite('a catalog that never answers blocks nothing', () => {
  check('the status says it is loading', /Loading the catalog/.test(hanging), hanging);
  check('a built-in workout still loads', LIBRARY[1].id === 'sweet-spot' && workoutTitle() === 'Sweet spot 3 x 12'
    && lastWorkout?.source === 'builtin', workoutTitle());
  check('and the ride is shown', active('ride'));
});

settings.patch({ libraryFilters: NO_FILTERS, librarySection: 'workouts' });
report();
