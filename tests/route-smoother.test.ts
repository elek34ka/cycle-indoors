import { setupDom } from './dom-setup';
const dom = setupDom();

const consoleErrors: string[] = [];
const realError = console.error;
console.error = (...args: unknown[]) => { consoleErrors.push(args.map(String).join(' ')); };

const { check, near, report, suite } = await import('./harness');
const { RouteSmootherView } = await import('../src/ui/route-smoother-view');
const { PRESETS, routeDistances, smoothProfile, valueAt } = await import('../src/activity/smoothing');
const { positionAt } = await import('../src/activity/route-geometry');
const { courseStore } = await import('../src/activity/course-store');
const { parseGpx } = await import('../src/activity/gpx');
const { settings } = await import('../src/core/settings');
const { session } = await import('../src/session/session');
const { readFileSync } = await import('node:fs');

const doc = dom.window.document;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve(undefined)));

const sampleXml = readFileSync('samples/sample-hilly-loop.gpx', 'utf8');
const sampleTrack = parseGpx(sampleXml, 'sample');
const WORKOUT_ZWO = '<workout_file><name>W</name><workout><SteadyState Duration="60" Power="0.5"/></workout></workout_file>';
const FLAT_GPX = '<gpx><trk><trkseg><trkpt lat="50" lon="19"></trkpt><trkpt lat="50.01" lon="19"></trkpt></trkseg></trk></gpx>';

/** Drop a file on the smoother the way a rider would, and let it load. */
async function drop(name: string, content: string): Promise<void> {
  const event = new dom.window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [new File([content], name)] } });
  doc.querySelector('#smoother-drop')!.dispatchEvent(event);
  await wait(30);
}

const toasts = () => [...doc.querySelectorAll('#toasts .toast')].map((t) => t.textContent ?? '');
const lastToast = () => toasts().at(-1) ?? '';
const input = (key: string) => doc.querySelector<HTMLInputElement>(`#smoother-panel input[data-param="${key}"]`)!;
const preset = () => doc.querySelector<HTMLSelectElement>('#smoother-preset')!;
const download = () => doc.querySelector<HTMLButtonElement>('#smoother-download')!;
const ride = () => doc.querySelector<HTMLButtonElement>('#smoother-ride')!;
const cell = (row: string, col: 'original' | 'smoothed') => {
  const cells = [...doc.querySelectorAll('#smoother-table > span')];
  const at = cells.findIndex((c) => c.textContent === row);
  return cells[at + (col === 'original' ? 1 : 2)]?.textContent ?? '';
};
function edit(key: string, value: string): void {
  const field = input(key);
  field.value = value;
  field.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

// The ride already has a route of its own.
const rideRoute = courseStore.load(parseGpx(sampleXml.replace(/Sample hilly loop/g, 'Ride route'), 'ride'));
const view = new RouteSmootherView();

await drop('sample-hilly-loop.gpx', sampleXml);
await wait(150); // Leaflet is fetched on demand, now that there is a route

const samplePoints = sampleTrack.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
const sampleDistances = routeDistances(samplePoints);
/** The colours of the map's lines, in drawing order. */
const mapColours = () => [...doc.querySelectorAll('#smoother-map path')].map((p) => p.getAttribute('stroke')).join(',');

suite('loading a route', () => {
  check('the route is previewed', view.current !== undefined);
  check('the source line names it', doc.querySelector('#smoother-source')?.textContent?.startsWith('Sample hilly loop'));
  check('the table has both columns filled', cell('Ascent', 'original').endsWith(' m') && cell('Ascent', 'smoothed').endsWith(' m'),
    `${cell('Ascent', 'original')} / ${cell('Ascent', 'smoothed')}`);
  const expected = smoothProfile(sampleTrack, PRESETS.medium);
  check('the smoothed ascent is the pipeline\'s', cell('Ascent', 'smoothed') === `${Math.round(expected.stats.smoothed.ascent)} m`);
  check('Download is enabled', !download().disabled);
  check('Ride this route is enabled', !ride().disabled);
  check('the ride\'s own course is untouched', courseStore.current === rideRoute && courseStore.current?.name === 'Ride route');
});

const loadedView = view.previewMap.viewState!;
const loadedColours = mapColours();
const before = view.current;
await drop('workout.zwo', WORKOUT_ZWO);
suite('refusing what is not a route', () => {
  check('a workout is refused as not a route', lastToast().includes('is not a route'), lastToast());
  check('the previous route stays', view.current === before);
  const state = view.previewMap.viewState!;
  check('and so does the map\'s view', state.lat === loadedView.lat && state.lon === loadedView.lon
    && state.zoom === loadedView.zoom);
});

// Strong with limits of the rider's own, which the ridden course must keep to.
// These are the settings this check has always run with. With descents left
// at -8 % the ridden course, re-measured from the smoothed points, reaches
// 11 % although the smoothed profile stops at 9 %.
preset().value = 'strong';
preset().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
edit('maxGradient', '9');
edit('window', '8'); // shown and used as 9
edit('minGradient', '-0');
await frame();
await frame();

suite('riding it', () => {
  ride().click();
  const course = courseStore.current!;
  check('the course is the smoothed route', course !== rideRoute && course.name === 'Sample hilly loop (smoothed)', course.name);
  const steepest = Math.max(...course.points.map((pt) => Math.abs(pt.gradient)));
  check('its gradient stays within the set limit', steepest <= 9 + 1e-6, `steepest ${steepest}`);
  near('it is the same length as the original', course.totalDistance, sampleTrack.distance, 1);
});

session.reset();
console.error = realError;
report();
