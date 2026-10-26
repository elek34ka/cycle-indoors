import { IDBFactory } from 'fake-indexeddb';
import { setupDom } from './dom-setup';
const dom = setupDom();

const { check, report, suite, until } = await import('./harness');
const { bootApp } = await import('../src/ui/app');
const { session } = await import('../src/session/session');
const { settings } = await import('../src/core/settings');
const { CatalogClient } = await import('../src/catalog/client');
const { openLibraryStore } = await import('../src/library/db');
const { NO_FILTERS } = await import('../src/library/filter');

const doc = dom.window.document;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => wait(80);

if (session.snapshot.state === 'running' || session.snapshot.state === 'paused') session.finish();
settings.patch({ libraryFilters: NO_FILTERS, librarySection: 'workouts' });

const may = (day: number) => new Date(2026, 4, day, 7, 30).getTime();
const ride = (startedAt: number, extra: object = {}) => ({
  startedAt, duration: 3600, distance: 30_000, avgPower: 200, normalisedPower: 210, tss: 64, ascent: 0, ...extra,
});
const factory = new IDBFactory();
const seed = await openLibraryStore(factory);
await seed.logRide(ride(may(1), { workout: { key: 'builtin:quick', title: 'Quick spin' } }));
await seed.logRide(ride(may(3), { route: { key: 'mine:abc', name: 'Hilly loop' }, ascent: 412, avgHr: 141, stravaActivityId: 4242 }));
await seed.logRide(ride(may(2)));
await seed.setDone('builtin:quick', true);

bootApp({ catalog: new CatalogClient('', fetch), store: openLibraryStore(factory) });

const lib = (sel: string) => doc.querySelector<HTMLElement>(`#library-root ${sel}`);
const rows = () => Array.from(doc.querySelectorAll<HTMLElement>('#library-root .lib-list .lib-item'));
doc.querySelector<HTMLButtonElement>('#tabs [data-tab="library"]')!.click();
await settle();
lib('.lib-sections [data-section="rides"]')!.click();
await settle();

const listed = rows();
const titles = listed.map((r) => r.querySelector('.lib-title')?.textContent);
const filtersShown = lib('.lib-filters')!.childElementCount;
listed[0].click();
const detail = lib('.lib-detail')!.textContent ?? '';
const strava = lib('.lib-detail .lib-ride-strava') as HTMLAnchorElement | null;

suite('My rides lists the log', () => {
  check('a My rides section', lib('.lib-sections [data-section="rides"]')?.textContent === 'My rides');
  check('newest first: 3, 2, then 1 May', listed.map((r) => r.dataset.key).join() === [may(3), may(2), may(1)].map((t) => `ride:${t}`).join(),
    listed.map((r) => r.dataset.key).join());
  check('named by workout, else route, else free ride', titles.join() === 'Hilly loop,Free ride,Quick spin', titles.join());
  check('with duration, distance, power and TSS', /1:00:00 · 30\.00 km · 200 W · TSS 64/.test(listed[0].textContent ?? ''),
    listed[0].textContent ?? '');
  check('one on Strava says so', /On Strava/.test(listed[0].textContent ?? '') && !/On Strava/.test(listed[1].textContent ?? ''));
  check('no filters for a plain log', filtersShown === 0);
  check('details show the numbers and what was ridden', /Normalised210 W/.test(detail) && /Avg HR141 bpm/.test(detail)
    && /Climbed412 m/.test(detail) && /Route/.test(detail) && /Hilly loop/.test(detail), detail);
  check('and link to the Strava activity', strava?.getAttribute('href') === 'https://www.strava.com/activities/4242'
    && strava.getAttribute('target') === '_blank');
});

rows().find((r) => r.dataset.key === `ride:${may(1)}`)!.click();
lib('.lib-detail .lib-remove')!.click();
await settle();
const dialogText = doc.querySelector('.confirm-overlay')?.textContent ?? '';
Array.from(doc.querySelectorAll<HTMLButtonElement>('.confirm-overlay button')).find((b) => b.textContent === 'Cancel')!.click();
await settle();
const afterCancel = rows().length;
lib('.lib-detail .lib-remove')!.click();
await settle();
Array.from(doc.querySelectorAll<HTMLButtonElement>('.confirm-overlay button')).find((b) => b.textContent === 'Remove')!.click();
const stored = await until(async () => (await openLibraryStore(factory)).rides(), (r) => r.length === 2);
await settle();
const marks = await (await openLibraryStore(factory)).doneMarks();

suite('removing a ride', () => {
  check('asks first, saying done marks and Strava are untouched', /Remove this ride\?/.test(dialogText) && /not touched/.test(dialogText), dialogText);
  check('cancel keeps it', afterCancel === 3);
  check('confirm removes it from the list and from storage', rows().length === 2 && stored.length === 2
    && !stored.some((r) => r.startedAt === may(1)));
  check('the workout it rode keeps its done mark', marks.some((m) => m.key === 'builtin:quick'));
});

settings.patch({ librarySection: 'workouts' });
report();
