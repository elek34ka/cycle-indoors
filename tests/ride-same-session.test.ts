import { IDBFactory } from 'fake-indexeddb';
import { setupDom } from './dom-setup';
const dom = setupDom();

const { check, report, suite, until } = await import('./harness');
const { bootApp } = await import('../src/ui/app');
const { session } = await import('../src/session/session');
const { settings } = await import('../src/core/settings');
const { courseStore } = await import('../src/activity/course-store');
const { buildCatalog } = await import('../src/catalog/build');
const { CatalogClient } = await import('../src/catalog/client');
const { openLibraryStore } = await import('../src/library/db');
const { NO_FILTERS } = await import('../src/library/filter');
const { entryFor, routeEntryFor } = await import('../src/library/loaded');
const { readFileSync } = await import('node:fs');

const doc = dom.window.document;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => wait(80);
const enc = (s: string) => new TextEncoder().encode(s);

if (session.snapshot.state === 'running' || session.snapshot.state === 'paused') session.finish();
settings.patch({ libraryFilters: NO_FILTERS, librarySection: 'rides' });

const build = await buildCatalog([
  { path: 'workouts/Over_Unders.zwo', bytes: enc(`<workout_file><name>Over Unders</name><workout>
    <SteadyState Duration="600" Power="0.95"/><SteadyState Duration="300" Power="1.05"/></workout></workout_file>`) },
  { path: 'routes/sample-hilly-loop.gpx', bytes: new Uint8Array(readFileSync('samples/sample-hilly-loop.gpx')) },
]);
const W = build.index.workouts[0];
const R = build.index.routes[0];
const BASE = 'https://pub-test.r2.dev';
const objects = new Map<string, Uint8Array>([
  [`${BASE}/index.json`, enc(JSON.stringify(build.index))],
  ...build.files.map((f) => [`${BASE}/${f.key}`, f.bytes] as [string, Uint8Array]),
]);
const fetched: string[] = [];
const fetchFn = async (url: string) => {
  fetched.push(url);
  const body = objects.get(url);
  return body ? new Response(body as BlobPart) : new Response('missing', { status: 404 });
};

const may = (day: number) => new Date(2026, 4, day, 7, 30).getTime();
const ride = (startedAt: number, extra: object = {}) => ({
  startedAt, duration: 3600, distance: 30_000, avgPower: 200, normalisedPower: 210, tss: 64, ascent: 0, ...extra,
});
const factory = new IDBFactory();
const seed = await openLibraryStore(factory);
// 5 May: the catalog workout on the catalog route, as logged now.
await seed.logRide(ride(may(5), {
  workout: { key: `catalog:${W.id}`, sha256: W.file.sha256, title: 'Over Unders' },
  route: { key: `catalog:${R.id}`, sha256: R.file.sha256, name: 'Hilly loop' },
}));
// 4 May: the same workout under a name the catalog no longer has: found by hash.
await seed.logRide(ride(may(4), { workout: { key: 'catalog:workout:workouts/Old_Name.zwo', sha256: W.file.sha256, title: 'Over Unders (old)' } }));
// 3 May: a built-in workout on a route that is gone.
await seed.logRide(ride(may(3), { workout: { key: 'builtin:quick-test', title: 'Quick spin' }, route: { key: 'mine:gone', name: 'Lost loop' } }));
// 2 May: a built-in workout alone.
await seed.logRide(ride(may(2), { workout: { key: 'builtin:quick-test', title: 'Quick spin' } }));
// 1 May: a free ride.
await seed.logRide(ride(may(1)));

bootApp({ catalog: new CatalogClient(BASE, fetchFn), store: openLibraryStore(factory) });

const lib = (sel: string) => doc.querySelector<HTMLElement>(`#library-root ${sel}`);
const row = (t: number) => doc.querySelector<HTMLElement>(`#library-root .lib-item[data-key="ride:${t}"]`)!;
const replay = () => lib('.lib-detail .lib-replay') as HTMLButtonElement | null;
const previews = () => Array.from(doc.querySelectorAll<HTMLElement>('#library-root .lib-detail .lib-ride-preview'));
const active = (name: string) => doc.querySelector(`#view-${name}`)?.classList.contains('active') === true;
const openRides = async () => {
  doc.querySelector<HTMLButtonElement>('#tabs [data-tab="library"]')!.click();
  await until(() => lib('.lib-item[data-key^="ride:"]'), (r) => r !== null);
  await settle();
};

await openRides();
const listText = lib('.lib-list')!.textContent ?? '';
const fetchedForList = fetched.filter((u) => u.includes('/files/')).length;
row(may(5)).click();
const both = previews().map((p) => `${p.dataset.status}:${p.querySelector('.lib-title')?.textContent}`);
const bothSvgs = previews().filter((p) => p.querySelector('svg')).length;
const bothButton = { text: replay()?.textContent, disabled: replay()?.disabled };

suite('a past ride\'s preview', () => {
  check('the list shows no previews and fetches no files', !/Ride same session/.test(listText) && fetchedForList === 0);
  check('clicking a ride shows its workout and its route', both.join() === `found:Over Unders,found:${R.name}`, both.join());
  check('each with its profile', bothSvgs === 2);
  check('and Ride same session, enabled', bothButton.text === 'Ride same session' && bothButton.disabled === false);
});

replay()!.click();
await until(() => active('ride'), (on) => on);
await settle();
const loadedWorkout = session.snapshot.workout;
const loadedCourse = courseStore.current;

suite('Ride same session', () => {
  check('loads the workout', loadedWorkout?.name === 'Over Unders', loadedWorkout?.name);
  check('and the route', loadedCourse !== undefined && Math.round(loadedCourse.totalDistance) === Math.round(R.distance));
  check('and goes to the ride', active('ride'));
  check('known again as the same Library entries, with their hashes', entryFor(loadedWorkout)?.key === `catalog:${W.id}`
    && entryFor(loadedWorkout)?.sha256 === W.file.sha256 && routeEntryFor(loadedCourse)?.key === `catalog:${R.id}`);
});

await openRides();
row(may(4)).click();
const renamed = previews().map((p) => p.dataset.status).join();
const renamedReady = replay()?.disabled === false;
row(may(3)).click();
const halfStatus = previews().map((p) => p.dataset.status).join();
const halfText = lib('.lib-detail')!.textContent ?? '';
const halfButton = replay();
halfButton?.click();
await settle();
const stayed = active('library') && session.snapshot.workout?.name === 'Over Unders';
row(may(1)).click();
const freeButton = replay();

suite('when it cannot, or there is nothing to ride', () => {
  check('a renamed catalog file is found by its hash', renamed === 'found' && renamedReady, renamed);
  check('a route that is gone: "No route found", and the workout still previewed', halfStatus === 'found,missing'
    && /No route found/.test(halfText) && /Lost loop/.test(halfText), halfText);
  check('and Ride same session cannot be pressed', halfButton !== null && halfButton.disabled
    && /not in the Library/.test(halfButton.title));
  check('pressing it anyway changes nothing', stayed);
  check('a free ride has no workout, no route and no button', freeButton === null && previews().length === 0);
});

// The built-in on its own: the route from before is unloaded, as that ride had none.
row(may(2)).click();
replay()!.click();
await until(() => active('ride'), (on) => on);
await settle();

suite('the same session, and nothing else', () => {
  check('the built-in workout is loaded', entryFor(session.snapshot.workout)?.key === 'builtin:quick-test');
  check('and the route that ride did not have is gone', courseStore.current === undefined);
});

// Back to the first: while a ride is in progress, it cannot be pressed.
await openRides();
row(may(5)).click();
session.start();
await settle();
const locked = replay()?.disabled === true;
session.finish();
await settle();
doc.querySelector<HTMLButtonElement>('.overlay:not(.hidden) .summary-close, #summary-close')?.click();

suite('during a ride', () => {
  check('Ride same session is disabled', locked);
});

settings.patch({ librarySection: 'workouts' });
report();
