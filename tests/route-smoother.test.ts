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

suite('before a route is loaded', () => {
  check('the panel has its heading', doc.querySelector('#smoother-panel h2')?.textContent === 'Route smoother');
  check('Medium is selected by default', preset().value === 'medium');
  check('the fields show Medium', input('window').value === String(PRESETS.medium.window)
    && input('maxGradient').value === String(PRESETS.medium.maxGradient));
  check('Download is disabled', download().disabled);
  check('Ride this route is disabled', ride().disabled);
  check('the map block is hidden with the rest of the preview',
    doc.querySelector<HTMLElement>('#smoother-map')?.closest<HTMLElement>('.smoother-body')?.hidden === true);
  check('and Leaflet has not been loaded', view.previewMap.viewState === undefined);
});

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

suite('the map', () => {
  check('is shown', doc.querySelector<HTMLElement>('#smoother-map')?.closest<HTMLElement>('.smoother-body')?.hidden === false);
  const state = view.previewMap.viewState;
  check('has loaded', state !== undefined);
  if (!state) return;
  const lats = samplePoints.map((p) => p.lat);
  const lons = samplePoints.map((p) => p.lon);
  const { south, west, north, east } = state.bounds;
  check('frames the whole route', Math.min(...lats) >= south && Math.max(...lats) <= north
    && Math.min(...lons) >= west && Math.max(...lons) <= east, JSON.stringify(state.bounds));
});

const loadedView = view.previewMap.viewState!;
const loadedColours = mapColours();
const before = view.current;
await drop('workout.zwo', '<workout_file><name>W</name><workout><SteadyState Duration="60" Power="0.5"/></workout></workout_file>');
suite('refusing what is not a route', () => {
  check('a workout is refused as not a route', lastToast().includes('is not a route'), lastToast());
  check('the previous route stays', view.current === before);
  const state = view.previewMap.viewState!;
  check('and so does the map\'s view', state.lat === loadedView.lat && state.lon === loadedView.lon
    && state.zoom === loadedView.zoom);
});

await drop('flat.gpx', '<gpx><trk><trkseg><trkpt lat="50" lon="19"></trkpt><trkpt lat="50.01" lon="19"></trkpt></trkseg></trk></gpx>');
suite('refusing a route without elevation', () => {
  check('it says there is no elevation', lastToast() === 'This route has no elevation to smooth', lastToast());
  check('the previous route stays', view.current === before);
});

suite('presets and advanced fields', () => {
  preset().value = 'strong';
  preset().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  check('Strong fills its values', input('window').value === String(PRESETS.strong.window)
    && input('maxChange').value === String(PRESETS.strong.maxChange));
  check('and is remembered', settings.current.routeSmoothing.preset === 'strong');

  edit('maxGradient', '9');
  check('editing a field switches to Custom', preset().value === 'custom');
  check('and keeps the edit', settings.current.routeSmoothing.maxGradient === 9
    && settings.current.routeSmoothing.window === PRESETS.strong.window);

  edit('window', '8');
  check('an even window shows as the next odd', input('window').value === '9');
  check('and is the one used', settings.current.routeSmoothing.window === 9);

  edit('minGradient', '-0');
  edit('maxGradient', '0');
  check('min ≥ max is refused', lastToast() === 'Min gradient must be below max gradient', lastToast());
  check('the old value stays in the field', input('maxGradient').value === '9');
  check('and in force', settings.current.routeSmoothing.maxGradient === 9);

  edit('spacing', '500');
  check('an out-of-range value is refused', lastToast().startsWith('Resample spacing must be between'), lastToast());
  check('and the field goes back', input('spacing').value === String(PRESETS.strong.spacing));
});

await frame();
await frame();

suite('the preview follows the parameters', () => {
  const p = view.current!;
  check('the preview uses the custom window', p.params.window === 9);
  check('and the custom cap', p.smoothedGradient.every((g) => g <= 9 + 1e-9), `max ${Math.max(...p.smoothedGradient)}`);
  check('the table follows', cell('Largest change', 'smoothed') === `${p.stats.smoothed.maxChange.toFixed(1)} % / 10 m`);
  const state = view.previewMap.viewState!;
  check('the map keeps its view', state.lat === loadedView.lat && state.lon === loadedView.lon
    && state.zoom === loadedView.zoom);
  check('but is recoloured', mapColours() !== loadedColours);
});

suite('hovering the charts', () => {
  const p = view.current!;
  const readout = () => doc.querySelector('#smoother-readout')?.textContent ?? '';
  const canvas = doc.querySelector<HTMLCanvasElement>('#smoother-gradient')!;
  canvas.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 150, clientY: 60, bubbles: true }));
  // 320 px wide, 52 px left and 14 px right padding: x 150 is (150-52)/254 of the route.
  const d = ((150 - 52) / 254) * p.distances[p.distances.length - 1];
  check('the readout gives the distance', readout().startsWith(`${(d / 1000).toFixed(2)} km`), readout());
  check('and the original height there', readout().includes(`original ${Math.round(valueAt(p, p.original, d))} m`), readout());
  check('and the smoothed height there', readout().includes(`smoothed ${Math.round(valueAt(p, p.smoothed, d))} m`), readout());
  doc.querySelector('#smoother-elevation')!.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 150, clientY: 60, bubbles: true }));
  check('the elevation chart reads the same place', readout().startsWith(`${(d / 1000).toFixed(2)} km`), readout());
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerleave', { bubbles: true }));
  check('leaving clears it', readout().startsWith('Hover a chart'), readout());
});

suite('hovering links the charts and the map', () => {
  const p = view.current!;
  const readout = () => doc.querySelector('#smoother-readout')?.textContent ?? '';
  const elevation = doc.querySelector<HTMLCanvasElement>('#smoother-elevation')!;
  elevation.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 150, clientY: 60, bubbles: true }));
  const d = ((150 - 52) / 254) * p.distances[p.distances.length - 1];
  const expected = positionAt(samplePoints, sampleDistances, d);
  const marker = view.previewMap.viewState!.hover;
  check('a chart hover puts a marker on the map', marker !== undefined);
  near('at that distance\'s latitude', marker?.lat ?? NaN, expected.lat, 1e-7);
  near('and longitude', marker?.lon ?? NaN, expected.lon, 1e-7);
  elevation.dispatchEvent(new dom.window.MouseEvent('pointerleave', { bubbles: true }));
  check('leaving the chart removes it', view.previewMap.viewState!.hover === undefined);

  const at = positionAt(samplePoints, sampleDistances, 4200);
  view.previewMap.hoverAt(at.lat, at.lon);
  check('hovering the map\'s line fills the readout at that distance', readout().startsWith('4.20 km'), readout());
  check('and marks it on the map', view.previewMap.viewState!.hover !== undefined);
  view.previewMap.hoverAt(undefined);
  check('leaving the line restores the prompt', readout().startsWith('Hover a chart'), readout());
  check('and removes the marker', view.previewMap.viewState!.hover === undefined);
});

let downloaded: Blob | undefined;
let downloadName = '';
const realCreate = dom.window.URL.createObjectURL;
dom.window.URL.createObjectURL = (blob: Blob) => { downloaded = blob; return 'blob:test'; };
const anchorClick = dom.window.HTMLAnchorElement.prototype.click;
dom.window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { downloadName = this.download; };
download().click();
const downloadedText = downloaded
  ? await new Promise<string>((resolve) => {
    const reader = new dom.window.FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(downloaded!);
  })
  : '';
dom.window.URL.createObjectURL = realCreate;
dom.window.HTMLAnchorElement.prototype.click = anchorClick;

suite('downloading', () => {
  const p = view.current!;
  check('the file is named after the original', downloadName === 'sample-hilly-loop-smoothed.gpx', downloadName);
  check('it is a GPX', downloaded?.type === 'application/gpx+xml', downloaded?.type);
  const back = parseGpx(downloadedText, 'x');
  check('it has every original point', back.points.length === sampleTrack.points.length);
  const worst = Math.max(...back.points.map((pt) => Math.abs(pt.ele! - valueAt(p, p.smoothed, pt.distance))));
  check('its heights are the smoothed profile', worst <= 0.1, `worst ${worst}`);
  check('the ride\'s course is still untouched', courseStore.current === rideRoute);
});

session.start();
await wait(0);
suite('mid-ride', () => {
  check('Ride this route is disabled while running', ride().disabled);
  check('the hint says why', doc.querySelector('#smoother-ride-hint')?.textContent?.includes('mid-ride'));
  session.pause();
  check('and while paused', ride().disabled);
  ride().disabled = false; // even a forced click must not swap the course
  ride().click();
  check('a forced click changes nothing', courseStore.current === rideRoute);
  session.finish();
  check('after Finish it is enabled again', !ride().disabled);
});

suite('riding it', () => {
  ride().click();
  const course = courseStore.current!;
  check('the course is the smoothed route', course !== rideRoute && course.name === 'Sample hilly loop (smoothed)', course.name);
  const steepest = Math.max(...course.points.map((pt) => Math.abs(pt.gradient)));
  check('its gradient stays within the set limit', steepest <= 9 + 1e-6, `steepest ${steepest}`);
  near('it is the same length as the original', course.totalDistance, sampleTrack.distance, 1);
});

suite('reset to defaults', () => {
  settings.reset();
  check('the smoother goes back to Medium', preset().value === 'medium' && input('window').value === String(PRESETS.medium.window));
});

session.reset();
console.error = realError;
suite('console', () => {
  check('nothing reached console.error', consoleErrors.length === 0, consoleErrors.join(' | '));
});

report();
