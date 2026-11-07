import { IDBFactory } from 'fake-indexeddb';
import { setupDom } from './dom-setup';
const dom = setupDom();

const { check, report, until } = await import('./harness');
const { bootApp } = await import('../src/ui/app');
const { session } = await import('../src/session/session');
const { settings } = await import('../src/core/settings');
const { courseStore } = await import('../src/activity/course-store');
const { buildCatalog } = await import('../src/catalog/build');
const { CatalogClient } = await import('../src/catalog/client');
const { openLibraryStore } = await import('../src/library/db');
const { NO_FILTERS } = await import('../src/library/filter');
const { hideSummary } = await import('../src/ui/summary');
const { openRouteSceneView } = await import('../src/ui/route-scene-view');
const { readFileSync } = await import('node:fs');
import type { RendererLoader, SceneRenderer } from '../src/scene/render/types';

/** `suite` for async bodies: the harness's own does not wait for them. */
async function suite(name: string, body: () => Promise<void> | void): Promise<void> {
  console.log(`\n${name}`);
  await body();
}

const doc = dom.window.document;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => wait(80);
const enc = (s: string) => new TextEncoder().encode(s);

// Earlier suites share the session and settings singletons.
if (session.snapshot.state === 'running' || session.snapshot.state === 'paused') session.finish();
hideSummary();
settings.reset();
settings.patch({ libraryFilters: NO_FILTERS, librarySection: 'routes' });

const SAMPLE = readFileSync('samples/sample-hilly-loop.gpx', 'utf8');
const MINE = SAMPLE.replace(/Sample hilly loop/g, 'My hilly loop');
const POINT = '<gpx><trk><name>Point</name><trkseg><trkpt lat="50" lon="19"><ele>100</ele></trkpt></trkseg></trk></gpx>';
const build = await buildCatalog([
  { path: 'routes/georgia/sample-hilly-loop.gpx', bytes: enc(SAMPLE) },
  { path: 'routes/point.gpx', bytes: enc(POINT) },
]);
const BASE = 'https://pub-test.r2.dev';
const objects = new Map<string, Uint8Array>([
  [`${BASE}/index.json`, enc(JSON.stringify(build.index))],
  ...build.files.map((f) => [`${BASE}/${f.key}`, f.bytes] as [string, Uint8Array]),
]);
const hilly = build.index.routes.find((r) => r.path.endsWith('sample-hilly-loop.gpx'))!;

const net = { calls: [] as string[], filesDown: false, corrupt: undefined as string | undefined };
const fetchFn = async (url: string) => {
  net.calls.push(url);
  if (!url.endsWith('index.json')) {
    if (net.filesDown) throw new TypeError('Failed to fetch');
    if (net.corrupt && url.endsWith(net.corrupt)) return new Response('tampered');
  }
  const body = objects.get(url);
  return body ? new Response(body as BlobPart) : new Response('missing', { status: 404 });
};

/** A renderer that draws nothing; the loader counts its calls. */
let loaderCalls = 0;
const fakeLoader: RendererLoader = async () => {
  loaderCalls++;
  return () => ({
    canvas: doc.createElement('canvas'),
    setResolution() {}, setExaggeration() {}, build() {}, drop() {}, clear() {}, render() {}, onContextLost() {}, dispose() {},
  } satisfies SceneRenderer);
};

const factory = new IDBFactory();
bootApp({ catalog: new CatalogClient(BASE, fetchFn), store: openLibraryStore(factory), sceneRenderer: fakeLoader });
const kept = async () => (await openLibraryStore(factory)).list();

const tab = (name: string) => doc.querySelector<HTMLButtonElement>(`#tabs [data-tab="${name}"]`)!;
const active = (name: string) => doc.querySelector(`#view-${name}`)?.classList.contains('active') === true;
const section = (name: string) => doc.querySelector<HTMLButtonElement>(`#library-root .lib-sections [data-section="${name}"]`)!;
const row = (key: string) => doc.querySelector<HTMLElement>(`#library-root .lib-item[data-key="${key}"]`);
const detail = () => doc.querySelector<HTMLElement>('#library-root .lib-detail')!;
const sceneButton = () => detail().querySelector<HTMLButtonElement>('.lib-scene');
const rideButton = () => detail().querySelector<HTMLButtonElement>('.lib-actions .lib-ride');
const lastToast = () => Array.from(doc.querySelectorAll('#toasts .toast')).pop()?.textContent ?? '';
const fileCalls = () => net.calls.filter((c) => !c.endsWith('index.json')).length;
const windowOpen = () => doc.querySelector('.scene-dialog') !== null;
const closeWindow = () => openRouteSceneView()?.close();
const drop = (zone: string, name: string, text: string) => {
  const event = new dom.window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [new File([text], name)] } });
  doc.querySelector(`#${zone}`)!.dispatchEvent(event);
};
const press = async () => { sceneButton()!.click(); await settle(); };
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
row(HILLY)!.click();

await suite('route details offer 3D view', () => {
  check('3D view sits next to Ride and Smooth', sceneButton()?.textContent === '3D view'
    && rideButton() !== null && detail().querySelector('.lib-smooth') !== null);
  check('nothing is fetched, and no renderer loaded, until it is pressed', fileCalls() === 0 && loaderCalls === 0);
  check('a route with under two GPS points is not even listed: the catalog refuses it', build.index.routes.length === 1
    && build.problems.some((p) => p.path === 'routes/point.gpx'));
});

net.filesDown = true;
await press();
const downToast = lastToast();
net.filesDown = false;
net.corrupt = hilly.file.key;
await press();
const staleToast = lastToast();
net.corrupt = undefined;

await suite('a file that cannot be fetched opens no window', () => {
  check('a download failure gives Ride\'s error', /^Could not load "Sample hilly loop": Could not download/.test(downToast), downToast);
  check('a file that does not match the index: catalog out of date', /out of date/.test(staleToast), staleToast);
  check('no window', !windowOpen() && loaderCalls === 0);
  check('3D view is offered again', sceneButton()?.textContent === '3D view' && !sceneButton()!.disabled);
});

const before = fileCalls();
await press();
await until(() => loaderCalls, (n) => n > 0);

await suite('3D view on a catalog route', () => {
  check('its file was fetched by its hash key', fileCalls() === before + 1 && net.calls.at(-1)?.endsWith(hilly.file.key) === true);
  check('the window opens', windowOpen() && doc.querySelector('.scene-card h2')?.textContent === 'Route 3D preview · Sample hilly loop');
  check('over the Library, which is still the current view', active('library') && !active('ride'));
  check('the ride\'s course is unchanged', courseStore.current === rideCourse);
  closeWindow();
  check('closing returns to the Library', !windowOpen() && active('library'));
});

row(mineKey)!.click();
const callsMine = net.calls.length;
await press();
await until(() => windowOpen(), (v) => v);

await suite('3D view on a My library route', () => {
  check('the window opens', windowOpen() && doc.querySelector('.scene-card h2')?.textContent === 'Route 3D preview · My hilly loop');
  check('with no network request', net.calls.length === callsMine, net.calls.slice(callsMine).join(', '));
  closeWindow();
});

session.start();
await settle();
row(HILLY)!.click();
await settle();
const rideLocked = rideButton()?.disabled === true;
await press();
await until(() => windowOpen(), (v) => v);

await suite('mid-ride', () => {
  check('Ride is disabled', rideLocked);
  check('3D view still works', windowOpen());
  check('the ride keeps running on its own course', session.snapshot.state === 'running' && courseStore.current === rideCourse);
  closeWindow();
});

session.finish();
hideSummary();
check('the ride\'s course was never replaced', courseStore.current === rideCourse);
report();
