import { IDBFactory } from 'fake-indexeddb';
import { setupDom } from './dom-setup';
const dom = setupDom();

const { check, report, suite } = await import('./harness');
const { bootApp } = await import('../src/ui/app');
const { session } = await import('../src/session/session');
const { settings } = await import('../src/core/settings');
const { buildCatalog } = await import('../src/catalog/build');
const { CatalogClient } = await import('../src/catalog/client');
const { openLibraryStore } = await import('../src/library/db');
const { PersonalLibrary } = await import('../src/library/personal');
const { NO_FILTERS } = await import('../src/library/filter');
const { LibraryView } = await import('../src/ui/library-view');
const { hideSummary } = await import('../src/ui/summary');

const doc = dom.window.document;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => wait(80);
const enc = (s: string) => new TextEncoder().encode(s);
const zwo = (name: string, seconds = 600) =>
  enc(`<workout_file><name>${name}</name><workout><SteadyState Duration="${seconds}" Power="0.7"/></workout></workout_file>`);

if (session.snapshot.state === 'running' || session.snapshot.state === 'paused') session.finish();
session.reset();
settings.patch({ libraryFilters: NO_FILTERS, librarySection: 'workouts' });

const build = await buildCatalog([
  { path: 'workouts/vo2/The_Famous_40_20_s.zwo', bytes: zwo("The Famous 40/20's") },
  { path: 'workouts/vo2/Short_40_20.zwo', bytes: zwo('Short 40/20') },
  { path: 'plans/Base_Builder/Week_1/1_1_Easy.zwo', bytes: zwo('Easy') },
  { path: 'plans/Base_Builder/Week_1/1_2_Tempo.zwo', bytes: zwo('Tempo') },
  { path: 'plans/Base_Builder/Week_2/2_1_Long.zwo', bytes: zwo('Long') },
  { path: 'plans/Other_Plan/O_1.zwo', bytes: zwo('Other one') },
]);
const BASE = 'https://pub-test.r2.dev';
const objects = new Map<string, Uint8Array>([
  [`${BASE}/index.json`, enc(JSON.stringify(build.index))],
  ...build.files.map((f) => [`${BASE}/${f.key}`, f.bytes] as [string, Uint8Array]),
]);
const fetchFn = async (url: string) => {
  const body = objects.get(url);
  return body ? new Response(body as BlobPart) : new Response('missing', { status: 404 });
};

const factory = new IDBFactory();
bootApp({ catalog: new CatalogClient(BASE, fetchFn), store: openLibraryStore(factory) });

const K = {
  forty: 'catalog:workout:vo2/The_Famous_40_20_s',
  short: 'catalog:workout:vo2/Short_40_20',
  easy: 'catalog:workout:plans/Base_Builder/Week_1/1_1_Easy',
  tempo: 'catalog:workout:plans/Base_Builder/Week_1/1_2_Tempo',
  long: 'catalog:workout:plans/Base_Builder/Week_2/2_1_Long',
};
const lib = (sel: string) => doc.querySelector<HTMLElement>(`#library-root ${sel}`);
const row = (key: string) => lib(`.lib-list .lib-item[data-key="${key}"]`);
const rowKeys = () => Array.from(doc.querySelectorAll<HTMLElement>('#library-root .lib-list .lib-item')).map((r) => r.dataset.key ?? '');
const section = (name: string) => lib(`.lib-sections [data-section="${name}"]`)!.click();
const select = (name: string, value: string) => {
  const s = lib(`[data-filter="${name}"]`) as HTMLSelectElement;
  s.value = value;
  s.dispatchEvent(new dom.window.Event('change'));
};
const search = (text: string) => {
  const input = lib('[data-filter="search"]') as HTMLInputElement;
  input.value = text;
  input.dispatchEvent(new dom.window.Event('input'));
};
const marksInStorage = async () => (await (await openLibraryStore(factory)).doneMarks()).map((m) => m.key).sort();
const upNext = () => doc.querySelector<HTMLElement>('#up-next')!;
const upNextText = () => (upNext().hidden ? '' : upNext().textContent ?? '');

doc.querySelector<HTMLButtonElement>('#tabs [data-tab="library"]')!.click();
await settle();

row(K.forty)!.click();
const toggleBefore = lib('.lib-detail .lib-done-toggle')!.textContent;
// The catalog has its own fetch; anything on the global one would be a mark leaving the browser.
const realFetch = globalThis.fetch;
let markRequests = 0;
globalThis.fetch = (async () => { markRequests++; throw new TypeError('offline'); }) as typeof fetch;
lib('.lib-detail .lib-done-toggle')!.click();
await settle();
globalThis.fetch = realFetch;
const badge = row(K.forty)?.querySelector('.lib-done')?.textContent ?? '';
const toggleAfter = lib('.lib-detail .lib-done-toggle')!.textContent;
const storedAfterMark = await marksInStorage();

search('40/20');
const searchRows = rowKeys().map((k) => ({ k, done: row(k)?.querySelector('.lib-done') !== null }));
search('');
select('done', 'todo');
const todoKeys = rowKeys();
select('done', 'done');
const doneKeys = rowKeys();
settings.patch({ libraryFilters: NO_FILTERS });

suite('marking in the Library', () => {
  check('the details offer Mark as done', toggleBefore === 'Mark as done', toggleBefore ?? '');
  check('the row shows Done with the date', /^Done \S+/.test(badge), badge);
  check('the details now offer Mark as not done', toggleAfter === 'Mark as not done', toggleAfter ?? '');
  check('the mark is in IndexedDB', storedAfterMark.join() === K.forty, storedAfterMark.join());
  check('and no request carries it: no backup has been made', markRequests === 0);
  check('search shows which match is done', searchRows.length === 2
    && searchRows.find((r) => r.k === K.forty)?.done === true && searchRows.find((r) => r.k === K.short)?.done === false,
    JSON.stringify(searchRows));
  check('Not done hides it', !todoKeys.includes(K.forty) && todoKeys.includes(K.short));
  check('Done shows only it', doneKeys.join() === K.forty, doneKeys.join());
  check('the done filter is remembered with the others', settings.current.libraryFilters.done === 'any');
});

// A plan workout is one entry: marking it in Workouts shows in its plan.
row(K.easy)!.click();
lib('.lib-detail .lib-done-toggle')!.click();
await settle();
section('plans');
const planMeta = row('catalog:plan:Base_Builder')?.querySelector('.lib-meta')?.textContent ?? '';
row('catalog:plan:Base_Builder')!.click();
const easyItem = lib('.lib-plan-workouts li[data-key="' + K.easy + '"]');
const easyBadge = easyItem?.querySelector('.lib-done') !== null;
lib(`.lib-plan-workouts li[data-key="${K.tempo}"] .lib-done-toggle`)!.click();
await settle();
const tempoDone = (await marksInStorage()).includes(K.tempo);
lib(`.lib-plan-workouts li[data-key="${K.tempo}"] .lib-done-toggle`)!.click();
await settle();
const tempoUndone = !(await marksInStorage()).includes(K.tempo);
select('done', 'todo');
const todoInPlan = Array.from(doc.querySelectorAll<HTMLElement>('#library-root .lib-plan-workouts li')).map((li) => li.dataset.key);
settings.patch({ libraryFilters: NO_FILTERS });

suite('marks in plans', () => {
  check('the plan counts the mark made from Workouts', /· 1 of 3 done$/.test(planMeta), planMeta);
  check('the plan detail shows it Done', easyBadge);
  check('a plan row can be marked done', tempoDone);
  check('and undone', tempoUndone);
  check('the done filter applies to plan details', todoInPlan.join() === [K.tempo, K.long].join(), todoInPlan.join());
});

const hiddenBeforeFollow = upNext().hidden;
lib('.lib-detail .lib-follow')!.click();
await settle();
const followedText = upNextText();
const libUpNext = lib('.lib-up-next')?.textContent ?? '';
lib(`.lib-plan-workouts li[data-key="${K.tempo}"] .lib-done-toggle`)!.click();
await settle();
const afterTempo = upNextText();
lib(`.lib-plan-workouts li[data-key="${K.long}"] .lib-done-toggle`)!.click();
await settle();
const complete = upNextText();
const rideOfferedWhenComplete = upNext().querySelector('.lib-ride') !== null;
lib(`.lib-plan-workouts li[data-key="${K.tempo}"] .lib-done-toggle`)!.click();
await settle();
const skippedAhead = upNextText();

suite('following a plan and Up next', () => {
  check('nothing on the Workout panel until a plan is followed', hiddenBeforeFollow);
  check('Up next is the first workout not done (Easy is done)', /Up next in Base Builder \(2 of 3\)/.test(followedText) && /Tempo/.test(followedText),
    followedText);
  check('the Plans section shows it too', /Up next in Base Builder/.test(libUpNext) && /Tempo/.test(libUpNext), libUpNext);
  check('a mark advances it', /Long/.test(afterTempo) && /3 of 3/.test(afterTempo), afterTempo);
  check('all done: complete, nothing offered', /complete — all 3 workouts done/.test(complete) && !rideOfferedWhenComplete,
    complete);
  check('skipping ahead: Up next goes back to the first not done', /Tempo/.test(skippedAhead), skippedAhead);
});

// Ride from Up next on the Workout panel, then finish and mark it done.
doc.querySelector<HTMLButtonElement>('#tabs [data-tab="ride"]')!.click();
upNext().querySelector<HTMLButtonElement>('.lib-ride')!.click();
await settle();
const loadedTitle = doc.querySelector('#workout-meta h3')?.textContent;
session.start();
await wait(30);
session.finish();
await settle();
const markButton = doc.querySelector<HTMLButtonElement>('#summary-overlay .summary-mark-done');
const markText = markButton?.textContent ?? '';
markButton?.click();
await settle();
const markedFromSummary = (await marksInStorage()).includes(K.tempo);
const afterSummary = upNextText();
hideSummary();
session.reset();

suite('marking after a ride', () => {
  check('Up next\'s Ride loads that workout', loadedTitle === 'Tempo', loadedTitle ?? '');
  check('the summary offers to mark it done, by name with its week', markText === 'Mark "Week 1 · Tempo" as done', markText);
  check('choosing it marks it', markedFromSummary);
  check('and Up next moves on', /complete/.test(afterSummary), afterSummary);
});

// Not chosen: a ride finished and the summary closed without marking.
doc.querySelector<HTMLButtonElement>('#tabs [data-tab="library"]')!.click();
await settle();
section('workouts');
row(K.short)!.querySelector<HTMLButtonElement>('.lib-ride')!.click();
await settle();
session.start();
await wait(30);
session.finish();
await settle();
const offeredShort = doc.querySelector('#summary-overlay .summary-mark-done')?.textContent ?? '';
doc.querySelector<HTMLButtonElement>('#summary-overlay .btn-ghost')!.click();
const shortNotMarked = !(await marksInStorage()).includes(K.short);

// A different workout loaded mid-ride replaces the one offered.
session.reset();
session.start();
const drop = new dom.window.Event('drop', { bubbles: true, cancelable: true });
Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File([zwo('From disk')], 'from_disk.zwo')] } });
doc.querySelector('#workout-drop')!.dispatchEvent(drop);
await settle();
session.start();
await wait(30);
session.finish();
await settle();
const offeredAfterSwap = doc.querySelector('#summary-overlay .summary-mark-done')?.textContent ?? '';
doc.querySelector<HTMLButtonElement>('#summary-overlay .summary-mark-done')?.click();
await settle();
const mineMarks = (await marksInStorage()).filter((k) => k.startsWith('mine:'));
hideSummary();

// No workout loaded at all.
session.reset();
session.loadWorkout(undefined);
session.start();
await wait(30);
session.finish();
await settle();
const offeredFreeRide = doc.querySelector('#summary-overlay .summary-mark-done') !== null;
hideSummary();
session.reset();

suite('when the summary offers a mark', () => {
  check('a catalog workout is offered', offeredShort === 'Mark "Short 40/20" as done', offeredShort);
  check('closing the summary marks nothing', shortNotMarked);
  check('a file loaded mid-ride replaces the offer, once My library keeps it', offeredAfterSwap === 'Mark "From disk" as done',
    offeredAfterSwap);
  check('and marks the My library entry', mineMarks.length === 1);
  check('no workout loaded: nothing offered', !offeredFreeRide);
});

doc.querySelector<HTMLButtonElement>('#tabs [data-tab="library"]')!.click();
await settle();
section('plans');
row('catalog:plan:Other_Plan')!.click();
lib('.lib-detail .lib-follow')!.click();
await settle();
const switched = upNextText();
const firstPlanRow = rowKeys()[0];
const baseMeta = row('catalog:plan:Base_Builder')?.querySelector('.lib-meta')?.textContent ?? '';
lib('.lib-detail .lib-follow')!.click();
await settle();
const stopped = upNext().hidden && (await (await openLibraryStore(factory)).followed()) === undefined;

suite('switching and stopping', () => {
  check('following another plan replaces it, without asking', /Up next in Other Plan/.test(switched)
    && doc.querySelector('.confirm-overlay') === null, switched);
  check('the first plan keeps its marks', /3 of 3 done/.test(baseMeta), baseMeta);
  check('the followed plan is listed first', firstPlanRow === 'catalog:plan:Other_Plan', firstPlanRow);
  check('Stop following hides Up next and forgets the plan', stopped);
});

// Fresh views over the same storage: a plan that was unpublished, and a
// catalog that cannot be reached.
const store = await openLibraryStore(factory);
await store.follow('plan:Gone_Plan');
const personal = new PersonalLibrary(Promise.resolve(store));
const host = { loadBuiltin: () => false, loadFile: async () => false, showRide: () => {} };
const goneRoot = doc.createElement('div');
new LibraryView(goneRoot, host, new CatalogClient(BASE, fetchFn), personal);
await settle();
const goneText = goneRoot.querySelector('.lib-up-next')?.textContent ?? '';
const offlineRoot = doc.createElement('div');
new LibraryView(offlineRoot, host, new CatalogClient(BASE, async () => { throw new TypeError('offline'); }), personal);
await settle();
const offlineText = offlineRoot.querySelector('.lib-up-next')?.textContent ?? '';

suite('when the followed plan cannot be shown', () => {
  check('a plan no longer in the catalog says so', /"Gone Plan", is no longer published/.test(goneText), goneText);
  check('an unreachable catalog says Up next is unavailable', /Up next is unavailable/.test(offlineText), offlineText);
});

settings.patch({ libraryFilters: NO_FILTERS, librarySection: 'workouts' });
report();
