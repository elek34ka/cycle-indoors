import { setupDom } from './dom-setup';
const dom = setupDom();

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
const { parseZwo } = await import('../src/workout/zwo');
const { hideSummary } = await import('../src/ui/summary');
const { readFileSync } = await import('node:fs');
const { LIBRARY } = await import('../src/workout/library');

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
    hidden: root?.style.display === 'none',
  };
};

// The simulator is off by default now, so a test that wants to ride has to
// ask for it the same way the rider would.
const simulatorDefault = settings.current.useMockDevices;
settings.patch({ useMockDevices: true });

let bootError: Error | undefined;
try { bootApp(); } catch (err) { bootError = err as Error; }

suite('boot', () => {
  check('bootApp does not throw', bootError === undefined, bootError?.stack);
  check('seven metric tiles are rendered', doc.querySelectorAll('#metrics .tile').length === 7,
    `got ${doc.querySelectorAll('#metrics .tile').length}`);
  check('the climb tile is hidden until a route is loaded', tile(5).hidden);
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
  check('the library select lists every workout plus its placeholder',
    doc.querySelectorAll('#library-select option').length === LIBRARY.length + 1,
    `${doc.querySelectorAll('#library-select option').length} options for ${LIBRARY.length} workouts`);
  check('the simulator is off by default', simulatorDefault === false);
  check('the workout graph has a canvas', doc.querySelector('#profile') !== null);
});

await wait(1800);

suite('simulated devices feed the dashboard', () => {
  check('a trainer and a strap are registered once the simulator is switched on',
    hub.list().length === 2, hub.list().map((d) => d.label).join(', '));
  check('the trainer connected', mock.trainer.status === 'connected', mock.trainer.status);
  check('the strap connected', mock.hrm.status === 'connected', mock.hrm.status);
  const snapshot = hub.snapshot();
  check('power is flowing', snapshot.power !== undefined, JSON.stringify(snapshot));
  check('heart rate is flowing', snapshot.heartRate !== undefined && snapshot.heartRate > 40,
    String(snapshot.heartRate));
  check('the trainer chip shows watts', /\d+ W/.test(doc.querySelector('#device-chips .chip span')?.textContent ?? ''),
    doc.querySelector('#device-chips .chip span')?.textContent ?? 'empty');
});

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

const biasBefore = session.snapshot.targetPower;
session.setErgBias(1.1);
const biasedTarget = session.snapshot.targetPower;
session.setErgBias(1);
session.setMode('free');
const freeTarget = session.snapshot.targetPower;
session.setGrade(4.5);
await wait(700); // the trainer command queue is throttled
const simMode = mock.rig.mode;
const simGrade = mock.rig.grade;
session.setMode('erg');
await wait(700);
const ergMode = mock.rig.mode;

suite('three-second, session and lap averages', () => {
  const s = session.snapshot;
  check('power shows a 3 s average', s.smoothedPower !== undefined, String(s.smoothedPower));
  check('heart rate shows a 3 s average', s.smoothedHeartRate !== undefined, String(s.smoothedHeartRate));
  check('a session average power is tracked', (s.avgPower ?? 0) > 0, String(s.avgPower));
  check('a session average heart rate is tracked', (s.avgHeartRate ?? 0) > 0, String(s.avgHeartRate));
  check('a lap average power is tracked', (s.lapAvgPower ?? 0) > 0, String(s.lapAvgPower));
  check('the power tile label names the smoothing window', tile(0).label === 'Power 3s', tile(0).label);
  check('the heart-rate tile label names the smoothing window', tile(2).label === 'Heart rate 3s', tile(2).label);
  check('the power tile sub-line shows session and lap averages',
    /avg \d+ · lap \d+/.test(tile(0).sub), tile(0).sub);
  check('the heart-rate tile sub-line shows session and lap averages',
    /avg \d+ · lap \d+/.test(tile(2).sub), tile(2).sub);
});

suite('bias, modes and seeking', () => {
  near('a 10% bias raises the target by 10%', biasedTarget, Math.round(biasBefore * 1.1), 2);
  check('free mode drops the ERG target', freeTarget === 0);
  check('free mode switches the trainer to simulation', simMode === 'sim', simMode);
  near('the grade reached the trainer', simGrade, 4.5, 0.01);
  check('the grade readout updated', doc.querySelector('#controls .readout')?.textContent !== undefined);
  check('ERG mode is restored', ergMode === 'erg', ergMode);

  const elapsedBefore = session.snapshot.elapsed;
  session.skipSegment(1);
  check('skipping moves to the next block', session.snapshot.elapsed > elapsedBefore, String(session.snapshot.elapsed));
  check('the block index advanced', session.snapshot.segmentIndex === 1, String(session.snapshot.segmentIndex));

  session.seek(-1000);
  check('seeking cannot go below zero', session.snapshot.elapsed === 0, String(session.snapshot.elapsed));
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
  check('the climb tile is now visible', !tile(5).hidden);
  check('the climb tile is labelled Climbed', tile(5).label === 'Climbed', tile(5).label);
  check('the climb tile shows a number', /^\d+$/.test(tile(5).value), tile(5).value);
  check('the climb tile sub-line shows the gradient and the climb per lap',
    /[+-]\d+\.\d% · \d+ m\/lap/.test(tile(5).sub), tile(5).sub);

  check('the session reports a position on the course', courseSnap.coursePosition !== undefined);
  check('following the route overrides the manual grade',
    courseSnap.effectiveGrade === courseSnap.coursePosition!.gradient,
    `${courseSnap.effectiveGrade} vs ${courseSnap.coursePosition!.gradient}`);
  near('the course gradient reached the trainer', followedGrade, courseSnap.coursePosition!.gradient, 0.5);
  check('ascent is being tracked in real time', (courseSnap.coursePosition!.totalAscent ?? -1) >= 0,
    String(courseSnap.coursePosition!.totalAscent));
});

session.seek(session.snapshot.workout!.duration - 1.5);
await wait(2200);

suite('finishing', () => {
  const s = session.snapshot;
  check('the ride finished on its own at the end of the workout', s.state === 'finished', s.state);
  check('the trainer target was released', mock.rig.targetPower === 0, String(mock.rig.targetPower));
  check('the summary overlay is showing', !doc.querySelector('#summary-overlay')?.classList.contains('hidden'));
  const summaryText = doc.querySelector('#summary-overlay')?.textContent ?? '';
  check('the summary offers a FIT download', summaryText.includes('Download .fit'));
  check('the summary shows TSS and normalised power',
    summaryText.includes('TSS') && summaryText.includes('Normalised'));
  check('laps were created from the workout blocks', s.laps.length >= 1, String(s.laps.length));
});

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

// --- a workout that is nothing but free riding ------------------------------
const freeEntry = LIBRARY.find((e) => e.id === 'free-ride-3h')!;
session.loadWorkout(parseZwo(freeEntry.zwo, { ftp: settings.current.ftp }));
session.setMode('erg'); // deliberately: the workout should override this
session.start();
await wait(1500);
const freeSnap = session.snapshot;
const freeRigMode = mock.rig.mode;
session.finish();
hideSummary();

suite('a free-ride workout overrides ERG mode', () => {
  near('it is three hours long', freeSnap.workout!.duration, 3 * 3600, 0.01);
  check('the mode toggle still says ERG', freeSnap.mode === 'erg');
  check('but the block is ridden free', freeSnap.effectiveMode === 'free', freeSnap.effectiveMode);
  check('there is no power target', freeSnap.targetPower === 0, String(freeSnap.targetPower));
  check('the trainer was switched to simulation', freeRigMode === 'sim', freeRigMode);
  check('the target tile shows no number', tile(1).value === '—', tile(1).value);
  check('the interval bar is flagged free',
    doc.querySelector('#interval-bar .mode-flag')?.textContent === 'free',
    doc.querySelector('#interval-bar .mode-flag')?.textContent ?? 'none');
  check('power was still recorded', freeSnap.samples.every((x) => x.power > 0),
    JSON.stringify(freeSnap.samples.map((x) => x.power)));
  check('and the bias control is hidden', (doc.querySelectorAll<HTMLElement>('#controls .group')[2]).style.display === 'none');
});

suite('tabs and the devices panel', () => {
  check('there are exactly two tabs', doc.querySelectorAll('#tabs button').length === 2);
  doc.querySelector<HTMLButtonElement>('#tabs button[data-tab="settings"]')?.click();
  check('the settings view became active', doc.querySelector('#view-settings')?.classList.contains('active'));
  check('the ride view is hidden', !doc.querySelector('#view-ride')?.classList.contains('active'));
  check('the settings form rendered its number fields',
    doc.querySelectorAll('#settings-form input[type="number"]').length === 6,
    `got ${doc.querySelectorAll('#settings-form input[type="number"]').length}`);
  check('the settings form rendered its toggles',
    doc.querySelectorAll('#settings-form input[type="checkbox"]').length === 4,
    `got ${doc.querySelectorAll('#settings-form input[type="checkbox"]').length}`);
  check('devices are managed from the settings page',
    (doc.querySelectorAll('#devices-panel .device-row').length ?? 0) === 2,
    String(doc.querySelectorAll('#devices-panel .device-row').length));
  check('there is a pairing button for every sensor kind',
    doc.querySelectorAll('#devices-panel .pair-row button').length === 5,
    String(doc.querySelectorAll('#devices-panel .pair-row button').length));
  check('the panel says why Bluetooth is unavailable in this environment',
    doc.querySelector('#ble-status')?.textContent?.includes('Web Bluetooth') ?? false,
    doc.querySelector('#ble-status')?.textContent ?? 'none');
  check('the simulated trainer is marked as connected',
    doc.querySelector('#devices-panel .device-row.is-connected') !== null);
  check('the panel names which device supplies each metric',
    (doc.querySelectorAll('#devices-panel .source-summary .row').length ?? 0) === 4,
    String(doc.querySelectorAll('#devices-panel .source-summary .row').length));
  check('the simulator is folded away in its own disclosure',
    doc.querySelector('#devices-panel details.sim-disclosure') !== null);
  check('the disclosure is collapsed',
    doc.querySelector<HTMLDetailsElement>('#devices-panel details.sim-disclosure')?.open === false);
  check('and it offers to remove the simulated devices while they are active',
    doc.querySelector('#devices-panel .sim-disclosure button')?.textContent === 'Remove simulated devices',
    doc.querySelector('#devices-panel .sim-disclosure button')?.textContent ?? 'none');
  doc.querySelector<HTMLButtonElement>('#tabs button[data-tab="ride"]')?.click();
  check('returning to the ride view works', doc.querySelector('#view-ride')?.classList.contains('active'));
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
