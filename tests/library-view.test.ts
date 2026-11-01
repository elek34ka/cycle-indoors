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

suite('Browse library opens the Library on Workouts', () => {
  check('the Library view is shown', active('library') && !active('ride'));
  check('on the Workouts section, even though Routes was last open', section('workouts').classList.contains('on'));
  check('the catalog was fetched once, fresh', net.calls.filter((c) => c.endsWith('index.json')).length === 1);
  check('the status says when the catalog was built', /Catalog updated/.test(doc.querySelector('#library-root .lib-status')!.textContent ?? ''));
});

suite('workouts from every source, labelled', () => {
  check(`${LIBRARY.length} built-in and ${CATALOG_WORKOUTS} catalog workouts`, rows().length === LIBRARY.length + CATALOG_WORKOUTS, String(rows().length));
  const forty = row('catalog:workout:vo2/The_Famous_40_20_s');
  check('a catalog workout is labelled Catalog', forty.querySelector('.lib-source')?.textContent === 'Catalog');
  check('a built-in one is labelled Built-in', row(`builtin:${LIBRARY[0].id}`).querySelector('.lib-source')?.textContent === 'Built-in');
  check('with its duration and TSS', /^32:00 · TSS \d+ · IF \d\.\d\d$/.test(forty.querySelector('.lib-meta')?.textContent ?? ''),
    forty.querySelector('.lib-meta')?.textContent ?? '');
  check('with its tags', forty.querySelector('.lib-tag')?.textContent === 'vo2');
  check('with a zone-coloured profile', forty.querySelectorAll('svg.lib-profile polygon').length === 26);
});

row('catalog:workout:vo2/The_Famous_40_20_s').click();

suite('selecting a workout shows its details', () => {
  const detail = doc.querySelector('#library-root .lib-detail')!;
  check('title and author', detail.querySelector('h2')?.textContent === "The Famous 40/20's"
    && detail.querySelector('.lib-author')?.textContent === 'by M.De Jode');
  const desc = detail.querySelector('.lib-desc')!;
  check('markup in a description is shown as text', desc.textContent?.includes('<b>Bold</b>') === true
    && desc.querySelector('b') === null, desc.innerHTML);
  check('line breaks are kept', desc.textContent?.includes('\n\nSecond paragraph.') === true);
  const blocks = Array.from(detail.querySelectorAll('.lib-blocks li')).map((li) => li.textContent);
  check('every block listed', blocks.length === 26);
  check(`in watts at the FTP in Settings (${settings.current.ftp} W)`,
    blocks[1] === `0:40${Math.round(1.2045 * settings.current.ftp)} W (120%)`, blocks[1] ?? '');
  check('the row is marked selected', row('catalog:workout:vo2/The_Famous_40_20_s').classList.contains('selected'));
});

// The Library describes the workout, not the rider: it keeps the standard zones.
const { POWER_ZONES } = await import('../src/core/zones');
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
const zonesBefore = settings.current.powerZoneBounds;
settings.patch({ powerZoneBounds: [0.55, 0.78, 0.90, 1.05, 1.20, 1.50] });
await settle();
row('catalog:workout:Steady_77').click();
const steadyProfile = row('catalog:workout:Steady_77').querySelector('svg.lib-profile polygon')?.getAttribute('fill');
const steadyLarge = doc.querySelector('#library-root .lib-detail svg.lib-profile-large polygon')?.getAttribute('fill');
const steadyBar = doc.querySelector<HTMLElement>('#library-root .lib-detail .lib-blocks li .bar')?.style.background;
settings.patch({ powerZoneBounds: zonesBefore });
await settle();

suite('the Library keeps the standard zones', () => {
  const z3 = POWER_ZONES[2].color;
  check('with Z2 to 78 %, a 77 % block is still Z3 in the list profile', steadyProfile === z3, String(steadyProfile));
  check('in the detail profile', steadyLarge === z3, String(steadyLarge));
  check('and in the detail block list', steadyBar === rgb(z3), String(steadyBar));
});

row('catalog:workout:vo2/The_Famous_40_20_s').click();
type(filter('search'), 'vo2');
const afterSearch = titles();
type(filter('search'), 'zzz-nothing');
const emptyText = doc.querySelector('#library-root .lib-empty')?.textContent ?? '';
doc.querySelector<HTMLButtonElement>('#library-root .lib-empty button')!.click();
const afterClear = rows().length;

suite('search and the empty state', () => {
  check('"vo2" leaves the vo2-tagged workout and the built-in with VO2 in its title',
    afterSearch.join(' | ') === "VO2 max 5 x 3 | The Famous 40/20's", afterSearch.join(' | '));
  check('no match says so and offers to clear', /No workouts match/.test(emptyText) && /Clear filters/.test(emptyText), emptyText);
  check('clearing brings everything back', afterClear === LIBRARY.length + CATALOG_WORKOUTS);
  check('and empties the search box', filter('search').value === '');
});

type(filter('search'), 'vo2');
filter('source').value = 'catalog';
filter('source').dispatchEvent(new dom.window.Event('change'));
type(filter('maxMinutes'), '45');
const second = doc.createElement('div');
new LibraryView(second, { loadBuiltin: () => false, loadFile: async () => false, showRide: () => {} }, client);

suite('filters are remembered', () => {
  check('kept in settings', settings.current.libraryFilters.search === 'vo2'
    && settings.current.libraryFilters.source === 'catalog' && settings.current.libraryFilters.maxMinutes === 45);
  check('a new Library shows them in its fields', second.querySelector<HTMLInputElement>('[data-filter="search"]')?.value === 'vo2'
    && second.querySelector<HTMLSelectElement>('[data-filter="source"]')?.value === 'catalog'
    && second.querySelector<HTMLInputElement>('[data-filter="maxMinutes"]')?.value === '45');
});
settings.patch({ libraryFilters: NO_FILTERS });

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
net.filesDown = true;
row('catalog:workout:WO5_Russian_Steps').querySelector<HTMLButtonElement>('.lib-ride')!.click();
await settle();
const downToast = lastToast();
const stillLoaded = workoutTitle();
net.filesDown = false;
net.corrupt = build.index.workouts.find((w) => w.id === 'workout:WO5_Russian_Steps')!.file.key;
row('catalog:workout:WO5_Russian_Steps').querySelector<HTMLButtonElement>('.lib-ride')!.click();
await settle();
const staleToast = lastToast();
net.corrupt = undefined;

suite('a file that cannot be loaded changes nothing', () => {
  check('download failure: says so', /Could not load "5\. Russian Steps".*Could not download/.test(downToast), downToast);
  check('the ride keeps its workout', stillLoaded === "The Famous 40/20's" && workoutTitle() === "The Famous 40/20's");
  check('a file that does not match the index: catalog out of date', /out of date/.test(staleToast), staleToast);
  check('the Library stays open', active('library'));
  check('Ride buttons usable again', rows().every((r) => !r.querySelector<HTMLButtonElement>('.lib-ride')?.disabled));
});

section('routes').click();
const routeRow = rows()[0];
const routeEntry = build.index.routes[0];
routeRow.querySelector<HTMLButtonElement>('.lib-ride')!.click();
await settle();

suite('routes', () => {
  check('listed with km and metres climbed', routeRow.querySelector('.lib-meta')?.textContent
    === `${(routeEntry.distance / 1000).toFixed(1)} km · ${Math.round(routeEntry.ascent)} m up`, routeRow.querySelector('.lib-meta')?.textContent ?? '');
  check('with an elevation thumbnail', routeRow.querySelector('svg polyline') !== null);
  check('tagged by folder', routeRow.querySelector('.lib-tag')?.textContent === 'georgia');
  check('Ride makes it the course', courseStore.current !== undefined && Math.round(courseStore.current.totalAscent) === Math.round(routeEntry.ascent));
  check('and shows the ride', active('ride'));
  check('the course knows its Library entry, for the ride log',
    routeEntryFor(courseStore.current)?.key === routeRow.dataset.key, routeEntryFor(courseStore.current)?.key);
});

// A route from anywhere else replaces the course, and with it the entry.
courseStore.load(parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'elsewhere'));

suite('a route loaded from elsewhere', () => {
  check('has no Library entry', courseStore.current !== undefined && routeEntryFor(courseStore.current) === undefined);
});

tab('library').click();
await settle();
section('plans').click();
const planRows = rows();
const planMetaText = planRows[0]?.querySelector('.lib-meta')?.textContent ?? '';
row('catalog:plan:Base_Builder').click();
const headings = Array.from(doc.querySelectorAll('#library-root .lib-plan-group')).map((h) => h.textContent);
const planItems = Array.from(doc.querySelectorAll<HTMLElement>('#library-root .lib-plan-workouts li'));
const planSearch = (text: string) => {
  const input = doc.querySelector<HTMLInputElement>('#library-root [data-filter="search"]')!;
  input.value = text;
  input.dispatchEvent(new dom.window.Event('input'));
  return rows().length;
};
const byPlanTitle = planSearch('builder');
const byWorkoutTitle = planSearch('long endurance');
const byNothing = planSearch('century');
const planEmptyShown = doc.querySelector('#library-root .lib-empty') !== null;
settings.patch({ libraryFilters: NO_FILTERS });
section('plans').click();
row('catalog:plan:Base_Builder').click();
doc.querySelector<HTMLButtonElement>('#library-root .lib-plan-workouts li[data-key="catalog:workout:plans/Base_Builder/Week_2/2_1_Endurance"] .lib-ride')!.click();
await settle();
const planRideTitle = workoutTitle();
const planRideActive = active('ride');

suite('plans are folders, listed with their shape', () => {
  check('one plan', planRows.length === 1);
  check('titled from the folder', planRows[0]?.querySelector('.lib-title')?.textContent === 'Base Builder');
  check('workouts, hours and TSS', /^4 workouts · 2\.5 h · TSS \d+ · 0 of 4 done$/.test(planMetaText), planMetaText);
  check('workouts in plan order: top level first, Week 2 before Week 10',
    planItems.map((li) => li.querySelector('.lib-plan-title')?.textContent).join(' | ') === 'Intro ride | Long endurance | Tempo | Taper',
    planItems.map((li) => li.querySelector('.lib-plan-title')?.textContent).join(' | '));
  check('sub-folders become headings, with spaces', headings.join(' | ') === 'Week 2 | Week 10', headings.join(' | '));
  check('each shows its duration and TSS', /^1:00:00 · TSS \d+$/.test(planItems[1]?.querySelector('.lib-meta')?.textContent ?? ''),
    planItems[1]?.querySelector('.lib-meta')?.textContent ?? '');
  check('each has a Ride button', planItems.every((li) => li.querySelector('.lib-ride') !== null));
  check('search matches the plan title', byPlanTitle === 1);
  check('and its workouts\' titles', byWorkoutTitle === 1);
  check('and says so when nothing matches', byNothing === 0 && planEmptyShown);
  check('Ride from a plan loads that workout and shows the ride', planRideTitle === 'Long endurance' && planRideActive);
});

tab('library').click();
await settle();
section('workouts').click();
const tagSelect = doc.querySelector<HTMLSelectElement>('#library-root [data-filter="tag"]')!;
const planTagOffered = Array.from(tagSelect.options).some((o) => o.value === 'Base Builder');
tagSelect.value = 'Base Builder';
tagSelect.dispatchEvent(new dom.window.Event('change'));
const taggedKeys = rows().map((r) => r.dataset.key ?? '');
const taggedTitles = rows().map((r) => r.querySelector('.lib-title')?.textContent ?? '');
settings.patch({ libraryFilters: NO_FILTERS });

suite('plan workouts are also ordinary workouts', () => {
  check('the plan title is a tag choice', planTagOffered);
  check('the tag lists exactly that plan\'s workouts', taggedKeys.length === 4
    && taggedKeys.every((k) => k.startsWith('catalog:workout:plans/Base_Builder/')), taggedKeys.join(', '));
  check('shown with their sub-folder in front, outside the plan', taggedTitles.includes('Week 2 · Long endurance')
    && taggedTitles.includes('Week 10 · Taper') && taggedTitles.includes('Intro ride'), taggedTitles.join(' | '));
  check('labelled Catalog', rows().some((r) => r.dataset.key?.includes('plans/Base_Builder')
    && r.querySelector('.lib-source')?.textContent === 'Catalog'));
});

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

net.indexDown = true;
tab('ride').click();
tab('library').click();
await settle();
const offline = {
  status: doc.querySelector('#library-root .lib-status')?.textContent ?? '',
  count: rows().length,
  catalogRows: rows().filter((r) => r.dataset.key?.startsWith('catalog:')).length,
};
net.indexDown = false;
const before = net.calls.filter((c) => c.endsWith('index.json')).length;
doc.querySelector<HTMLButtonElement>('#library-root .lib-status button')!.click();
await settle();

suite('an unreachable catalog', () => {
  check('says it is unavailable', /unavailable/.test(offline.status) && /Built-in workouts are still here/.test(offline.status), offline.status);
  check('built-in workouts still listed', offline.count === LIBRARY.length && offline.catalogRows === 0, String(offline.count));
  check('Retry fetches again', net.calls.filter((c) => c.endsWith('index.json')).length === before + 1);
  check('and the catalog comes back', rows().length === LIBRARY.length + CATALOG_WORKOUTS);
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
