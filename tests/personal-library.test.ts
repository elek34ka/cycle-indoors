import { IDBFactory } from 'fake-indexeddb';
import { setupDom } from './dom-setup';
const dom = setupDom();

const { check, report, suite, until } = await import('./harness');
const { bootApp } = await import('../src/ui/app');
const { session } = await import('../src/session/session');
const { settings } = await import('../src/core/settings');
const { courseStore } = await import('../src/activity/course-store');
const { routeEntryFor } = await import('../src/library/loaded');
const { CatalogClient } = await import('../src/catalog/client');
const { openLibraryStore } = await import('../src/library/db');
const { PersonalLibrary } = await import('../src/library/personal');
const { NO_FILTERS } = await import('../src/library/filter');
const { parseZwo } = await import('../src/workout/zwo');
const { parseGpx } = await import('../src/activity/gpx');
const { readFileSync } = await import('node:fs');

const doc = dom.window.document;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => wait(80);

if (session.snapshot.state === 'running' || session.snapshot.state === 'paused') session.finish();
settings.patch({ libraryFilters: NO_FILTERS, librarySection: 'workouts', ftp: 250 });

// Count every request: My library must never reach the network.
const realFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = (async () => { requests++; throw new TypeError('offline'); }) as typeof fetch;

// The browser asks to keep storage once, on the first file kept.
let persistCalls = 0;
Object.defineProperty(dom.window.navigator, 'storage', {
  value: { persist: async () => { persistCalls++; return true; } }, configurable: true,
});

const factory = new IDBFactory();
// No catalog in this suite: it is about the rider's own files.
bootApp({ catalog: new CatalogClient('', fetch), store: openLibraryStore(factory) });

const STEADY = `<workout_file><name>My steady hour</name><workout><SteadyState Duration="3600" Power="1.0"/></workout></workout_file>`;
const GPX = readFileSync('samples/sample-hilly-loop.gpx', 'utf8');
const drop = (zone: string, name: string, text: string) => {
  const event = new dom.window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [new File([text], name)] } });
  doc.querySelector(`#${zone}`)!.dispatchEvent(event);
};
const tab = (name: string) => doc.querySelector<HTMLButtonElement>(`#tabs [data-tab="${name}"]`)!;
const section = (name: string) => doc.querySelector<HTMLButtonElement>(`#library-root .lib-sections [data-section="${name}"]`)!;
const mineRows = () => Array.from(doc.querySelectorAll<HTMLElement>('#library-root .lib-item'))
  .filter((r) => r.dataset.key?.startsWith('mine:'));
const lastToast = () => Array.from(doc.querySelectorAll('#toasts .toast')).pop()?.textContent ?? '';
const kept = async () => (await openLibraryStore(factory)).list();

drop('workout-drop', 'my_steady.zwo', STEADY);
await settle();
drop('route-drop', 'hilly.gpx', GPX);
await settle();
drop('workout-drop', 'my_steady.zwo', STEADY);
await settle();
const afterDrops = await until(kept, (k) => k.length === 2);
const droppedRouteEntry = routeEntryFor(courseStore.current)?.key;
drop('workout-drop', 'broken.zwo', '<workout_file><workout>');
await settle();
const brokenToast = lastToast();
const afterBroken = await kept();

suite('files the rider loads are kept', () => {
  check('the workout and the route are kept, the repeat only once', afterDrops.length === 2, String(afterDrops.length));
  check('a new connection (a reload) still has them', afterDrops.some((f) => f.workout?.title === 'My steady hour')
    && afterDrops.some((f) => f.route !== undefined));
  check('with their original names and bytes', afterDrops.find((f) => f.workout)?.name === 'my_steady.zwo'
    && new TextDecoder().decode(afterDrops.find((f) => f.workout)!.bytes) === STEADY);
  check('summaries are stored for the Library', afterDrops.find((f) => f.workout)?.workout?.duration === 3600
    && (afterDrops.find((f) => f.route)?.route?.distance ?? 0) > 0);
  check('a broken file shows its error', /XML|workout/i.test(brokenToast), brokenToast);
  check('and is not kept', afterBroken.length === 2);
  check('storage persistence asked for once', persistCalls === 1, String(persistCalls));
  check('nothing went to the network', requests === 0, String(requests));
});

const both = new PersonalLibrary(openLibraryStore(new IDBFactory()));
const fitName = 'ride-with-steps.fit';
const outcome = await both.keep(new File(['fit bytes'], fitName), {
  fileName: fitName,
  workout: parseZwo(STEADY, { ftp: 250 }),
  track: parseGpx(GPX, 'ride'),
});
const bothFiles = await both.entries();
const { mineWorkouts, mineRoutes } = await import('../src/library/entries');
const indoor = await both.keep(new File(['indoor'], 'indoor.fit'), {
  fileName: 'indoor.fit',
  track: parseGpx('<gpx><trk><trkseg><trkpt lat="1" lon="1"/></trkseg></trk></gpx>', 'x'),
});

suite('a FIT file that is both a workout and a route', () => {
  check('kept once', outcome.outcome === 'added' && bothFiles.length === 1);
  check('listed under Workouts and Routes', mineWorkouts(bothFiles).length === 1 && mineRoutes(bothFiles).length === 1);
  check('under the same key in both', mineWorkouts(bothFiles)[0].key === mineRoutes(bothFiles)[0].key);
  check('an indoor ride with no GPS track is not kept as a route', indoor.outcome === 'not-a-workout-or-route');
});

tab('library').click();
await settle();
const workoutRows = mineRows();
const filterSource = doc.querySelector<HTMLSelectElement>('#library-root [data-filter="source"]')!;
filterSource.value = 'mine';
filterSource.dispatchEvent(new dom.window.Event('change'));
const onlyMine = Array.from(doc.querySelectorAll<HTMLElement>('#library-root .lib-item')).map((r) => r.dataset.key);
settings.patch({ libraryFilters: NO_FILTERS });

settings.patch({ ftp: 280 });
workoutRows[0].querySelector<HTMLButtonElement>('.lib-ride')!.click();
await settle();
const blockText = doc.querySelector('#segment-list li')?.textContent ?? '';
const rideActive = doc.querySelector('#view-ride')?.classList.contains('active');

suite('My library in the Library', () => {
  check('the kept workout is listed', workoutRows.length === 1);
  check('labelled My library', workoutRows[0]?.querySelector('.lib-source')?.textContent === 'My library');
  check('the source filter can show only My library', onlyMine.length === 1 && onlyMine[0]?.startsWith('mine:'));
  check('Ride loads it and shows the ride', rideActive === true && doc.querySelector('#workout-meta h3')?.textContent === 'My steady hour');
  check('at the FTP in Settings now (280 W), not the FTP it was imported at', blockText.includes('280 W (100%)'), blockText);
  check('still no network', requests === 0);
  check('a dropped route, once kept, is its My library entry for the ride log',
    droppedRouteEntry !== undefined && droppedRouteEntry === `mine:${afterDrops.find((f) => f.route)?.sha256}`, droppedRouteEntry);
});

tab('library').click();
await settle();
section('routes').click();
const route = mineRows()[0];
route.click();
const loadedCourse = courseStore.current;
doc.querySelector<HTMLButtonElement>('#library-root .lib-detail .lib-remove')!.click();
await settle();
const dialog = doc.querySelector('.confirm-overlay');
const dialogText = dialog?.textContent ?? '';
Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((b) => b.textContent === 'Cancel')!.click();
await settle();
const afterCancel = mineRows().length;
doc.querySelector<HTMLButtonElement>('#library-root .lib-detail .lib-remove')!.click();
await settle();
Array.from(doc.querySelectorAll<HTMLButtonElement>('.confirm-overlay button')).find((b) => b.textContent === 'Remove')!.click();
await settle();
const afterRemove = await until(kept, (k) => k.length === 1);

suite('removing an entry', () => {
  check('the loaded route came from the drop', loadedCourse !== undefined);
  check('asks first', dialog !== null && /Remove from My library\?/.test(dialogText), dialogText);
  check('says the file on disk and the ride are untouched', /not touched/.test(dialogText) && /keeps it/.test(dialogText));
  check('cancel keeps it', afterCancel === 1);
  check('confirm removes it from the list', mineRows().length === 0);
  check('and from storage', afterRemove.length === 1 && afterRemove[0].workout !== undefined);
  check('the ride keeps its course', courseStore.current === loadedCourse);
  check('the dialog is gone', doc.querySelector('.confirm-overlay') === null);
});

globalThis.fetch = realFetch;
settings.patch({ libraryFilters: NO_FILTERS, librarySection: 'workouts', ftp: 220 });
report();
