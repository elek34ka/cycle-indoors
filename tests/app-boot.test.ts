import { setupDom } from './dom-setup';
const dom = setupDom();

// Settings saved by a version that predates the sidebar toggle.
dom.window.localStorage.setItem('cycle-indoors.settings.v1', JSON.stringify({ ftp: 220, hrMax: 185 }));

const consoleErrors: string[] = [];
const realError = console.error;
console.error = (...args: unknown[]) => { consoleErrors.push(args.map(String).join(' ')); };

const { check, near, report, suite } = await import('./harness');
const { bootApp } = await import('../src/ui/app');
const { hub } = await import('../src/devices/hub');
const { mock } = await import('../src/devices/setup');
const { session } = await import('../src/session/session');
const { settings } = await import('../src/core/settings');
const { buildActivityFit } = await import('../src/activity/fit-export');
const { computeMetrics } = await import('../src/session/metrics');
const { decodeFit } = await import('../src/fit/decoder');
const { courseStore } = await import('../src/activity/course-store');
const { parseGpx } = await import('../src/activity/gpx');
const { hideSummary } = await import('../src/ui/summary');
const { readFileSync } = await import('node:fs');
const { CatalogClient } = await import('../src/catalog/client');

/** The 3D view's renderer loader, counting calls: nothing here should open one. */
let sceneLoaderCalls = 0;
const countingSceneLoader = async () => { sceneLoaderCalls++; throw new Error('the 3D view was not asked for'); };
/** Opening the Library fetches the catalog; never the real bucket from a test. */
const offlineCatalog = new CatalogClient('https://pub-test.r2.dev', async () => { throw new TypeError('offline'); });

const doc = dom.window.document;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The tile at a given position, by its own sub-elements — `.tile-value span`
 *  alone also matches the unit span. */
const tile = (index: number) => {
  const root = doc.querySelectorAll<HTMLElement>('#metrics .tile').item(index);
  return {
    root,
    label: root?.querySelector('.tile-label')?.textContent ?? '',
    value: root?.querySelector('.tile-value > span')?.textContent ?? '',
    sub: root?.querySelector('.tile-sub')?.textContent ?? '',
    /** the visible rows of the right-hand column, top to bottom */
    rows: Array.from(root?.querySelectorAll<HTMLElement>('.tile-side .tile-sub') ?? [])
      .filter((r) => r.style.display !== 'none').map((r) => r.textContent ?? ''),
    hidden: root?.style.display === 'none',
  };
};

// The simulator is off by default now, so a test that wants to ride has to
// ask for it the same way the rider would.
const simulatorDefault = settings.current.useMockDevices;
settings.patch({ useMockDevices: true });

let bootError: Error | undefined;
try { bootApp({ catalog: offlineCatalog, sceneRenderer: countingSceneLoader }); } catch (err) { bootError = err as Error; }

suite('boot', () => {
  check('bootApp does not throw', bootError === undefined, bootError?.stack);
  check('older settings load with the map in its default corner', settings.current.miniMapPosition === null);
  check('five metric tiles are rendered', doc.querySelectorAll('#metrics .tile').length === 5,
    `got ${doc.querySelectorAll('#metrics .tile').length}`);
  check('each in its own grid cell', doc.querySelector('#metrics')?.children.length === 5,
    String(doc.querySelector('#metrics')?.children.length));
  const order = Array.from(doc.querySelectorAll('#metrics .tile-label')).map((l) => l.textContent);
  check('Power, Target, Heart rate, Cadence, Elapsed',
    order.join(', ') === 'Power 3s, Target, Heart rate 3s, Cadence, Elapsed', order.join(', '));
  check('there is no Climbed or Speed tile', !order.includes('Climbed') && !order.includes('Speed'));
  check('every tile puts its value in a body row',
    Array.from(doc.querySelectorAll('#metrics .tile')).every((t) => t.querySelector('.tile-body > .tile-value') !== null));
  check('Elapsed is the timer alone', tile(4).root?.querySelector('.tile-side') === null
    && tile(4).root?.classList.contains('tile-hero') === true);
  check('the elevation strip is collapsed with no route',
    doc.querySelector('#graph-stack')?.classList.contains('no-route'));
  check('the map is not offered with no route loaded',
    doc.querySelector('#mini-map-host .mini-map')?.classList.contains('hidden') === true);
  check('nor is the button that would restore it',
    doc.querySelector('#mini-map-host .mini-map-show')?.classList.contains('hidden') === true);
  check('Leaflet is not loaded until there is a route to draw',
    doc.querySelector('#mini-map-host .leaflet-container') === null);
  check('there is no devices button in the top bar', doc.querySelector('#open-devices') === null);
  check('controls are rendered', doc.querySelectorAll('#controls .group').length >= 4);
  check('the first library workout is loaded', doc.querySelector('#workout-meta h3')?.textContent === 'Quick test',
    doc.querySelector('#workout-meta h3')?.textContent ?? 'none');
  check('the segment list is populated', doc.querySelectorAll('#segment-list li').length === 11,
    `got ${doc.querySelectorAll('#segment-list li').length}`);
  check('the workout drop-down is gone', doc.querySelector('#library-select') === null);
  check('a Browse library button takes its place', doc.querySelector('#workout-drop + #browse-library') !== null);
  check('the simulator is off by default', simulatorDefault === false);
  check('the workout graph has a canvas', doc.querySelector('#profile') !== null);
});

await wait(1800);

session.start();
await wait(2600);

suite('riding', () => {
  const s = session.snapshot;
  check('the session is running', s.state === 'running', s.state);
  check('time is advancing', s.elapsed > 2, String(s.elapsed));
  check('samples are being recorded at 1 Hz', s.samples.length >= 2 && s.samples.length <= 4,
    `got ${s.samples.length}`);
  check('the first block has an ERG target', s.targetPower > 0, String(s.targetPower));
  check('the target was sent to the trainer', mock.rig.targetPower > 0, String(mock.rig.targetPower));
  check('the trainer is in ERG mode', mock.rig.mode === 'erg');
  check('the session knows it can command the trainer', s.canControlTrainer === true);
  check('so the target tile does not warn about control', tile(1).sub !== 'no trainer control',
    tile(1).sub);
  check('recorded power is non-zero', s.samples.every((x) => x.power > 0),
    JSON.stringify(s.samples.map((x) => x.power)));
  check('the power tile shows a number',
    /^\d+$/.test(doc.querySelector('#metrics .tile .tile-value span')?.textContent ?? ''),
    doc.querySelector('#metrics .tile .tile-value span')?.textContent ?? 'empty');
  check('the interval bar shows a countdown', /\d+:\d\d/.test(doc.querySelector('#interval-bar .countdown')?.textContent ?? ''),
    doc.querySelector('#interval-bar .countdown')?.textContent ?? 'empty');
  check('the current block is highlighted in the list', doc.querySelectorAll('#segment-list li.current').length === 1);
});

const track = parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'sample');
const course = courseStore.load(track);
session.setMode('free');
session.setFollowCourse(true);
await wait(800);
const courseSnap = session.snapshot;
const followedGrade = mock.rig.grade;
session.setFollowCourse(false);
session.setMode('erg');
await wait(700);

suite('a loaded route drives the ride', () => {
  check('the route became a course', course !== undefined);
  check('the elevation strip expanded', !doc.querySelector('#graph-stack')?.classList.contains('no-route'));
  check('the mini map appeared', doc.querySelector('#mini-map-host .mini-map')?.classList.contains('hidden') === false);
  check('the map actually initialised', doc.querySelector('#mini-map-host .leaflet-container') !== null);
  check('the follow switch is drawn inside the map',
    doc.querySelector('#mini-map-host .leaflet-control-container .map-switch') !== null);
  check('there is no basemap layer picker any more',
    doc.querySelector('#mini-map-host .leaflet-control-layers') === null);
  check('the mini map names the route',
    doc.querySelector('#mini-map-host .mini-map-title')?.textContent === track.name,
    doc.querySelector('#mini-map-host .mini-map-title')?.textContent ?? 'none');
  check('the route stats list filled in', (doc.querySelectorAll('#route-stats .row').length ?? 0) >= 5,
    String(doc.querySelectorAll('#route-stats .row').length));
  const labels = Array.from(doc.querySelectorAll('#metrics .tile-label')).map((l) => l.textContent);
  check('still five tiles and no Climbed tile with a route', labels.length === 5 && !labels.includes('Climbed'),
    labels.join(', '));

  check('the session reports a position on the course', courseSnap.coursePosition !== undefined);
  check('following the route overrides the manual grade',
    courseSnap.effectiveGrade === courseSnap.coursePosition!.gradient,
    `${courseSnap.effectiveGrade} vs ${courseSnap.coursePosition!.gradient}`);
  near('the course gradient reached the trainer', followedGrade, courseSnap.coursePosition!.gradient, 0.5);
  check('ascent is being tracked in real time', (courseSnap.coursePosition!.totalAscent ?? -1) >= 0,
    String(courseSnap.coursePosition!.totalAscent));
  // On a route the tile shows the virtual speed, which the session owns.
  check('the cadence tile shows the session speed, not the raw sensor speed',
    Math.abs(parseFloat(tile(3).rows[0]) - (session.snapshot.speed ?? NaN)) < 0.6,
    `${tile(3).rows[0]} vs ${session.snapshot.speed} (sensor ${session.snapshot.live.speed})`);
});

const workoutDuration = session.snapshot.workout!.duration;
const lapsBeforeEnd = session.snapshot.laps.length;
session.seek(workoutDuration - 1.5 - session.snapshot.elapsed);
await wait(2600);
const overrun = session.snapshot;
const overrunRigMode = mock.rig.mode;

suite('the workout hands over to free riding instead of ending the ride', () => {
  check('the ride is still running', overrun.state === 'running', overrun.state);
  check('the workout is marked complete', overrun.workoutComplete === true);
  check('the clock has run past the workout', overrun.elapsed > workoutDuration,
    `${overrun.elapsed} vs ${workoutDuration}`);
  check('there is no block any more', overrun.segment === undefined);
  check('and no ERG target', overrun.targetPower === 0, String(overrun.targetPower));
  check('the ride is free even though the toggle says ERG',
    overrun.mode === 'erg' && overrun.effectiveMode === 'free', `${overrun.mode}/${overrun.effectiveMode}`);
  check('the trainer was switched to simulation', overrunRigMode === 'sim', overrunRigMode);
  check('a lap was closed at the boundary', overrun.laps.length > lapsBeforeEnd,
    `${lapsBeforeEnd} → ${overrun.laps.length}`);
  check('recording carried on past the end',
    overrun.samples.some((x) => x.t > workoutDuration), String(overrun.samples.length));
  check('the rider was told', overrun.message?.includes('free riding') ?? false,
    overrun.message ?? 'no message');
  check('the interval bar says the workout is complete',
    doc.querySelector('#interval-bar .now')?.textContent?.includes('complete') ?? false,
    doc.querySelector('#interval-bar .now')?.textContent ?? 'none');
  check('the time tile still shows only the timer', /^\d+:\d{2}(:\d{2})?$/.test(tile(4).value)
    && tile(4).root?.querySelector('.tile-sub') === null, tile(4).value);
  check('every block is marked done',
    doc.querySelectorAll('#segment-list li.done').length === overrun.workout!.segments.length,
    String(doc.querySelectorAll('#segment-list li.done').length));
  check('and none is current', doc.querySelectorAll('#segment-list li.current').length === 0);
});

session.finish();
await wait(120);

suite('finishing', () => {
  const s = session.snapshot;
  check('the ride is finished', s.state === 'finished', s.state);
  check('the trainer target was released', mock.rig.targetPower === 0, String(mock.rig.targetPower));
  check('the summary overlay is showing', !doc.querySelector('#summary-overlay')?.classList.contains('hidden'));
  const summaryText = doc.querySelector('#summary-overlay')?.textContent ?? '';
  check('the summary offers a FIT download', summaryText.includes('Download .fit'));
  check('the summary shows TSS and normalised power',
    summaryText.includes('TSS') && summaryText.includes('Normalised'));
  check('laps were created from the workout blocks', s.laps.length >= 1, String(s.laps.length));
});

hideSummary();

suite('the recorded ride exports as a valid FIT file', () => {
  const s = session.snapshot;
  const samples = [...s.samples];
  const metrics = computeMetrics(samples, settings.current.ftp);
  const bytes = buildActivityFit({
    startedAt: session.startedAt ?? new Date(), samples, laps: s.laps, metrics, name: 'jsdom ride',
  });
  check('the file is non-trivial', bytes.byteLength > 200, `${bytes.byteLength} bytes`);
  const fit = decodeFit(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  check('it decodes with a valid CRC', fit.crcOk);
  check('it has one record per recorded second', (fit.byName.get('record')?.length ?? 0) === samples.length,
    `${fit.byName.get('record')?.length} vs ${samples.length}`);
  check('it has a session message', (fit.byName.get('session')?.length ?? 0) === 1);
});

// Browse the Library's routes and smooth a route in Settings: neither opens a 3D view.
doc.querySelector<HTMLButtonElement>('#tabs [data-tab="library"]')?.click();
await wait(50);
doc.querySelector<HTMLButtonElement>('#library-root .lib-sections [data-section="routes"]')?.click();
{
  const event = new dom.window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [new File([readFileSync('samples/sample-hilly-loop.gpx', 'utf8')], 'sample-hilly-loop.gpx')] } });
  doc.querySelector('#smoother-drop')?.dispatchEvent(event);
}
await wait(150);

suite('the 3D view stays unloaded unless asked for', () => {
  check('the Library was browsed', doc.querySelector('#view-library')?.classList.contains('active') === true);
  check('the Settings smoother has the route', doc.querySelector('#smoother-source')?.textContent?.startsWith('Sample hilly loop') === true,
    doc.querySelector('#smoother-source')?.textContent ?? '');
  check('booting, riding, browsing and smoothing never loaded the 3D renderer', sceneLoaderCalls === 0, `${sceneLoaderCalls}`);
  check('and no 3D window opened', doc.querySelector('.scene-dialog') === null);
});

suite('no console errors along the way', () => {
  const unexpected = consoleErrors.filter((line) => !/leaflet|tile|jsdom|Not implemented/i.test(line));
  check('nothing was logged to console.error', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
});

console.error = realError;
report();

// Release the animation loop, the device timers and the jsdom window so the
// runner can move on to the next suite.
session.dispose();
await Promise.all(hub.list().map((d) => d.disconnect().catch(() => {})));
dom.window.close();
