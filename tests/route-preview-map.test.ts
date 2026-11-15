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

suite('hovering the line reports the distance', () => {
  const at = positionAt(points, distances, 5000);
  map.hoverAt(at.lat + 0.00005, at.lon);
  near('about 5 km', hovered.at(-1) ?? NaN, 5000, 50);
  map.hoverAt(undefined);
  check('leaving reports nothing', hovered.at(-1) === undefined && hovered.length === 2);
});

report();
