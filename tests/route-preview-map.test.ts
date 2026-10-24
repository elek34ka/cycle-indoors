import { setupDom } from './dom-setup';
const dom = setupDom();

const { RoutePreviewMap } = await import('../src/ui/route-preview-map');
const { gradientRuns, positionAt } = await import('../src/activity/route-geometry');
const { PRESETS, routeDistances, smoothProfile } = await import('../src/activity/smoothing');
const { parseGpx } = await import('../src/activity/gpx');
const { readFileSync } = await import('node:fs');
const { check, near, report, suite } = await import('./harness');

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const doc = dom.window.document;

const sample = parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'sample');
const points = sample.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
const distances = routeDistances(points);
const medium = gradientRuns(points, distances, smoothProfile(sample, PRESETS.medium));
const strong = gradientRuns(points, distances, smoothProfile(sample, PRESETS.strong));

const host = doc.createElement('div');
doc.body.append(host);
const map = new RoutePreviewMap(host);
const hovered: (number | undefined)[] = [];
map.onHover = (d) => hovered.push(d);

suite('before a route there is no map', () => {
  check('Leaflet is not loaded', map.viewState === undefined);
  check('no tile layer either', map.tiles === undefined);
});

await map.setRoute(points, distances, medium);

suite('a route is drawn and framed', () => {
  const view = map.viewState!;
  check('the map initialised', view !== undefined);
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const { south, west, north, east } = view.bounds;
  check('the whole route is inside the view',
    Math.min(...lats) >= south && Math.max(...lats) <= north && Math.min(...lons) >= west && Math.max(...lons) <= east,
    JSON.stringify(view.bounds));
  check('one line per coloured run', view.runs === medium.length, `${view.runs} vs ${medium.length}`);
  check('start, finish and casing are drawn', host.querySelectorAll('path').length >= medium.length + 3);
});

suite('recolouring keeps the rider\'s view', () => {
  const inside = positionAt(points, distances, 3000);
  (map as unknown as { map: { setView: (c: [number, number], z: number, o: object) => void } })
    .map.setView([inside.lat, inside.lon], 17, { animate: false });
  const before = map.viewState!;
  map.setColours(strong);
  const after = map.viewState!;
  check('the centre is unchanged', before.lat === after.lat && before.lon === after.lon);
  check('the zoom is unchanged', before.zoom === after.zoom && after.zoom === 17, String(after.zoom));
  check('the run count follows the new colours', after.runs === strong.length, `${after.runs} vs ${strong.length}`);
});

suite('the hover marker', () => {
  const at = positionAt(points, distances, 2500);
  map.setHover(at);
  const shown = map.viewState!.hover;
  check('is placed', shown !== undefined && Math.abs(shown.lat - at.lat) < 1e-9 && Math.abs(shown.lon - at.lon) < 1e-9);
  map.setHover(undefined);
  check('and removed', map.viewState!.hover === undefined);
});

suite('hovering the line reports the distance', () => {
  const at = positionAt(points, distances, 5000);
  map.hoverAt(at.lat + 0.00005, at.lon);
  near('about 5 km', hovered.at(-1) ?? NaN, 5000, 50);
  map.hoverAt(undefined);
  check('leaving reports nothing', hovered.at(-1) === undefined && hovered.length === 2);
});

suite('a tile that fails to load', () => {
  const notice = host.querySelector<HTMLElement>('.smoother-map-notice')!;
  check('no notice at first', notice.hidden);
  map.tiles!.fire('tileerror', { error: new Error('offline') });
  check('shows a notice', !notice.hidden && notice.textContent === 'Map tiles unavailable');
  map.tiles!.fire('tileload');
  check('which goes once tiles load again', notice.hidden);
});

const offlineHost = doc.createElement('div');
doc.body.append(offlineHost);
const offline = new RoutePreviewMap(offlineHost, { loadLeaflet: () => Promise.reject(new Error('Failed to fetch')) });
let threw = false;
try {
  await offline.setRoute(points, distances, medium);
  offline.setColours(strong);
  offline.setHover(positionAt(points, distances, 1000));
  offline.hoverAt(points[3].lat, points[3].lon);
  await offline.setRoute(points, distances, strong);
} catch {
  threw = true;
}
await wait(10);

suite('offline', () => {
  check('says the map is unavailable',
    offlineHost.textContent === 'Map unavailable — check your connection', offlineHost.textContent ?? '');
  check('nothing throws', !threw);
  check('and there is still no map', offline.viewState === undefined);
});

report();
