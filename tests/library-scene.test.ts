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

const tab = (name: string) => doc.querySelector<HTMLButtonElement>(`#tabs [data-tab="${name}"]`)!;
const active = (name: string) => doc.querySelector(`#view-${name}`)?.classList.contains('active') === true;
const section = (name: string) => doc.querySelector<HTMLButtonElement>(`#library-root .lib-sections [data-section="${name}"]`)!;
const row = (key: string) => doc.querySelector<HTMLElement>(`#library-root .lib-item[data-key="${key}"]`);
const detail = () => doc.querySelector<HTMLElement>('#library-root .lib-detail')!;
const sceneButton = () => detail().querySelector<HTMLButtonElement>('.lib-scene');
const rideButton = () => detail().querySelector<HTMLButtonElement>('.lib-actions .lib-ride');
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

tab('library').click();
await settle();
section('routes').click();
row(HILLY)!.click();

await suite('3D view is hidden until the setting is on', () => {
  check('off by default', settings.current.showRouteScene === false);
  check('no 3D view button, Ride and Smooth still there', sceneButton() === null
    && rideButton() !== null && detail().querySelector('.lib-smooth') !== null);
  check('the Settings tab offers it, unticked', (() => {
    const label = Array.from(doc.querySelectorAll('#view-settings .toggle-row')).find((r) => /Route 3D preview/.test(r.textContent ?? ''));
    const box = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    return box !== undefined && box !== null && !box.checked;
  })());
});

settings.patch({ showRouteScene: true });
await settle();

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

check('the ride\'s course was never replaced', courseStore.current === rideCourse);
report();
