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
const { PRESETS } = await import('../src/activity/smoothing');
const { hideSummary } = await import('../src/ui/summary');
const { readFileSync } = await import('node:fs');

const doc = dom.window.document;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => wait(80);
const frame = () => new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve(undefined)));
const enc = (s: string) => new TextEncoder().encode(s);

// Earlier suites share the session and settings singletons.
if (session.snapshot.state === 'running' || session.snapshot.state === 'paused') session.finish();
hideSummary();
settings.reset();
settings.patch({ libraryFilters: NO_FILTERS, librarySection: 'routes' });

const SAMPLE = readFileSync('samples/sample-hilly-loop.gpx', 'utf8');
const MINE = SAMPLE.replace(/Sample hilly loop/g, 'My hilly loop');
const FLAT = '<gpx><trk><name>Flat</name><trkseg><trkpt lat="50" lon="19"></trkpt>'
  + '<trkpt lat="50.01" lon="19"></trkpt><trkpt lat="50.02" lon="19"></trkpt></trkseg></trk></gpx>';

const build = await buildCatalog([
  { path: 'routes/georgia/sample-hilly-loop.gpx', bytes: enc(SAMPLE) },
  { path: 'routes/flat.gpx', bytes: enc(FLAT) },
]);
const BASE = 'https://pub-test.r2.dev';
const objects = new Map<string, Uint8Array>([
  [`${BASE}/index.json`, enc(JSON.stringify(build.index))],
  ...build.files.map((f) => [`${BASE}/${f.key}`, f.bytes] as [string, Uint8Array]),
]);
const hilly = build.index.routes.find((r) => r.path.endsWith('sample-hilly-loop.gpx'))!;
const flat = build.index.routes.find((r) => r.path.endsWith('flat.gpx'));

/** The stand-in network: switchable failures, a gate to hold files back, and a log. */
const net = {
  calls: [] as string[],
  filesDown: false,
  corrupt: undefined as string | undefined,
  gate: undefined as Promise<void> | undefined,
};
const fetchFn = async (url: string) => {
  net.calls.push(url);
  if (!url.endsWith('index.json')) {
    if (net.gate) await net.gate;
    if (net.filesDown) throw new TypeError('Failed to fetch');
    if (net.corrupt && url.endsWith(net.corrupt)) return new Response('tampered');
  }
  const body = objects.get(url);
  return body ? new Response(body as BlobPart) : new Response('missing', { status: 404 });
};

const factory = new IDBFactory();
bootApp({ catalog: new CatalogClient(BASE, fetchFn), store: openLibraryStore(factory) });
const kept = async () => (await openLibraryStore(factory)).list();

const tab = (name: string) => doc.querySelector<HTMLButtonElement>(`#tabs [data-tab="${name}"]`)!;
const active = (name: string) => doc.querySelector(`#view-${name}`)?.classList.contains('active') === true;
const section = (name: string) => doc.querySelector<HTMLButtonElement>(`#library-root .lib-sections [data-section="${name}"]`)!;
const row = (key: string) => doc.querySelector<HTMLElement>(`#library-root .lib-item[data-key="${key}"]`)!;
const detail = () => doc.querySelector<HTMLElement>('#library-root .lib-detail')!;
const smoothButton = () => detail().querySelector<HTMLButtonElement>('.lib-smooth');
const smoother = () => detail().querySelector<HTMLElement>('#lib-smoother');
const libRide = () => doc.querySelector<HTMLButtonElement>('#lib-smoother-ride')!;
const libPreset = () => doc.querySelector<HTMLSelectElement>('#lib-smoother-preset')!;
const tableText = (id: string) => [...doc.querySelectorAll(`#${id}-table > span`)].map((c) => c.textContent).join('|');
const lastToast = () => Array.from(doc.querySelectorAll('#toasts .toast')).pop()?.textContent ?? '';
const fileCalls = () => net.calls.filter((c) => !c.endsWith('index.json')).length;
const drop = (zone: string, name: string, text: string) => {
  const event = new dom.window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [new File([text], name)] } });
  doc.querySelector(`#${zone}`)!.dispatchEvent(event);
};
const smooth = async () => { smoothButton()!.click(); await settle(); };

const HILLY = `catalog:${hilly.id}`;

// The ride has a route of its own, which also puts it in My library.
drop('route-drop', 'my-hilly.gpx', MINE);
await settle();
const rideCourse = courseStore.current;
const [mine] = await until(kept, (k) => k.length > 0);
if (!mine) throw new Error('the dropped route was never kept in My library');
const mineKey = `mine:${mine.sha256}`;

tab('library').click();
await settle();
section('routes').click();
row(HILLY).click();

suite('a route\'s details offer Smooth', () => {
  check('the ride has its own course', rideCourse?.name === 'My hilly loop', rideCourse?.name);
  check('the catalog route is listed', row(HILLY) !== null);
  check('Smooth sits next to Ride', smoothButton()?.textContent === 'Smooth'
    && detail().querySelector('.lib-actions .lib-ride') !== null);
  check('no smoother until it is pressed', smoother() === null);
  check('and no file fetched yet', fileCalls() === 0);
});

net.filesDown = true;
await smooth();
const downToast = lastToast();
net.filesDown = false;
net.corrupt = hilly.file.key;
await smooth();
const staleToast = lastToast();
net.corrupt = undefined;

suite('a file that cannot be fetched is not smoothed', () => {
  check('a download failure says so', /^Could not smooth "Sample hilly loop": Could not download/.test(downToast), downToast);
  check('a file that does not match the index: catalog out of date', /out of date/.test(staleToast), staleToast);
  check('no smoother is shown', smoother() === null);
  check('Smooth is offered again', smoothButton()?.textContent === 'Smooth' && !smoothButton()!.disabled);
  check('the ride\'s course is unchanged', courseStore.current === rideCourse);
});

if (flat) {
  row(`catalog:${flat.id}`).click();
  await smooth();
}
suite('an unusable route is refused with its reason', () => {
  check('the catalog lists a route without elevation', flat !== undefined);
  check('the smoother\'s reason is shown', lastToast() === 'This route has no elevation to smooth', lastToast());
  check('no smoother is shown', smoother() === null && smoothButton()?.textContent === 'Smooth');
});

row(HILLY).click();
const callsBefore = fileCalls();
await smooth();
await wait(150); // Leaflet is fetched on demand
const host = smoother();

// The Settings smoother, given the same file.
drop('smoother-drop', 'sample-hilly-loop.gpx', SAMPLE);
await settle();

suite('Smooth opens the smoother on a catalog route', () => {
  check('its file was fetched by its hash key', fileCalls() === callsBefore + 1 && net.calls.at(-1)?.endsWith(hilly.file.key) === true);
  check('the smoother is in the route\'s details', host !== null && detail().contains(host));
  check('with its own heading', host?.querySelector('h2')?.textContent === 'Smooth this route');
  check('previewing that route', doc.querySelector('#lib-smoother-source')?.textContent?.startsWith('Sample hilly loop') === true);
  check('with the charts, the map and the table', host?.querySelector('#lib-smoother-elevation') !== null
    && host?.querySelector('#lib-smoother-gradient') !== null && host?.querySelector('#lib-smoother-map .leaflet-container') !== null
    && tableText('lib-smoother') !== '');
  check('Download and Ride this route are ready', !doc.querySelector<HTMLButtonElement>('#lib-smoother-download')!.disabled && !libRide().disabled);
  check('no file picker of its own', host?.querySelector('input[type=file], .drop-zone') === null);
  check('the button now closes it', smoothButton()?.textContent === 'Close smoother');
  check('the Library stays open', active('library'));
  check('the ride\'s course is unchanged', courseStore.current === rideCourse);
  check('the same figures as Settings for the same file', tableText('lib-smoother') === tableText('smoother'), tableText('lib-smoother'));
});

libPreset().value = 'strong';
libPreset().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
await frame();
await frame();
const afterPreset = smoother();
const settingsPreset = doc.querySelector<HTMLSelectElement>('#smoother-preset')!.value;
const input = doc.querySelector<HTMLInputElement>('#library-root [data-filter="search"]')!;
input.value = 'hilly';
input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
const afterFilter = smoother();

suite('it stays open while the route is shown', () => {
  check('a preset change keeps the same smoother', afterPreset === host);
  check('on the same route', doc.querySelector('#lib-smoother-source')?.textContent?.startsWith('Sample hilly loop') === true);
  check('and Settings follows the preset', settingsPreset === 'strong' && settings.current.routeSmoothing.window === PRESETS.strong.window);
  check('a filter that still shows it keeps it', afterFilter === host);
  check('and the figures still match Settings', tableText('lib-smoother') === tableText('smoother'));
});
input.value = '';
input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

row(mineKey).click();
const onOther = { smoother: smoother(), button: smoothButton()?.textContent };
row(HILLY).click();
const backAgain = { smoother: smoother(), button: smoothButton()?.textContent };

suite('selecting another route closes it', () => {
  check('the other route shows no smoother', onOther.smoother === null && onOther.button === 'Smooth');
  check('coming back shows Smooth again', backAgain.smoother === null && backAgain.button === 'Smooth');
});

row(mineKey).click();
const callsBeforeMine = net.calls.length;
await smooth();
await wait(50);

suite('a My library route', () => {
  check('opens the smoother on the kept file', smoother() !== null
    && doc.querySelector('#lib-smoother-source')?.textContent?.startsWith('My hilly loop') === true);
  check('without any request', net.calls.length === callsBeforeMine, net.calls.slice(callsBeforeMine).join(', '));
});

section('workouts').click();
section('routes').click();
suite('changing section closes it', () => {
  check('the route is still selected', row(mineKey).classList.contains('selected'));
  check('but shows Smooth and no smoother', smoother() === null && smoothButton()?.textContent === 'Smooth');
});

// A file still on its way when the rider moves on is dropped.
let open = () => {};
net.gate = new Promise((resolve) => { open = resolve; });
row(HILLY).click();
smoothButton()!.click();
const loadingText = smoothButton()?.textContent;
row(mineKey).click();
net.gate = undefined;
open();
await settle();
suite('a late file is dropped', () => {
  check('the button said it was loading', loadingText === 'Loading…', loadingText);
  check('the route now selected shows no smoother', smoother() === null && smoothButton()?.textContent === 'Smooth');
  row(HILLY).click();
  check('and neither does the one that was pressed', smoother() === null);
});

session.start();
await settle();
await smooth();
await wait(50);
const midRide = {
  open: smoother() !== null,
  rideDisabled: libRide().disabled,
  hint: doc.querySelector('#lib-smoother-ride-hint')?.textContent ?? '',
  download: !doc.querySelector<HTMLButtonElement>('#lib-smoother-download')!.disabled,
};
libRide().disabled = false;
libRide().click(); // a forced click
const forcedCourse = courseStore.current;
session.finish();
hideSummary();
await settle();

suite('mid-ride', () => {
  check('Smooth still opens the smoother', midRide.open);
  check('Ride this route is disabled', midRide.rideDisabled);
  check('with the mid-ride hint', midRide.hint.includes('mid-ride'), midRide.hint);
  check('Download still works', midRide.download);
  check('a forced click changes nothing', forcedCourse === rideCourse);
  check('after Finish Ride this route is enabled', !libRide().disabled);
});

const keptBefore = (await kept()).length;
libRide().click();
await settle();
suite('Ride this route', () => {
  check('opens the Ride view', active('ride') && !active('library'));
  check('with the smoothed route as the course', courseStore.current?.name === 'Sample hilly loop (smoothed)', courseStore.current?.name);
});
const keptAfter = (await kept()).length;
suite('…keeps nothing', () => {
  check('My library has no new route', keptAfter === keptBefore, `${keptBefore} → ${keptAfter}`);
});

tab('library').click();
await settle();
row(mineKey).click();
await smooth();
await wait(50);
const openOnMine = smoother() !== null;
detail().querySelector<HTMLButtonElement>('.lib-remove')!.click();
await settle();
Array.from(doc.querySelectorAll<HTMLButtonElement>('.confirm-overlay button')).find((b) => b.textContent === 'Remove')!.click();
await settle();

suite('removing the route closes it', () => {
  check('it was open on the My library route', openOnMine);
  check('the route is gone', row(mineKey) === null);
  check('and so is the smoother', doc.querySelector('#lib-smoother') === null || !doc.querySelector('#lib-smoother')!.isConnected);
});

session.reset();
report();
