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
const { parseZwo } = await import('../src/workout/zwo');
const { hideSummary } = await import('../src/ui/summary');
const { setParts } = await import('../src/ui/dom');
const { averages } = await import('../src/ui/ride-view');
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
try { bootApp(); } catch (err) { bootError = err as Error; }

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
  check('the library select lists every workout plus its placeholder',
    doc.querySelectorAll('#library-select option').length === LIBRARY.length + 1,
    `${doc.querySelectorAll('#library-select option').length} options for ${LIBRARY.length} workouts`);
  check('the simulator is off by default', simulatorDefault === false);
  check('the workout graph has a canvas', doc.querySelector('#profile') !== null);
});

suite('the sidebar can be folded away', () => {
  const view = doc.querySelector('#view-ride')!;
  const button = doc.querySelector<HTMLButtonElement>('.topbar #toggle-sidebar')!;
  const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = dom.window) =>
    target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, ...init }));

  check('older saved settings get the sidebar shown', settings.current.showSidebar === true);
  check('it starts visible', !view.classList.contains('sidebar-hidden'));
  check('the toggle sits in the top bar next to the tabs', button?.previousElementSibling?.id === 'tabs');
  check('it is no longer in the controls bar', doc.querySelector('#controls .sidebar-toggle') === null);
  check('the toggle says it is pressed', button.getAttribute('aria-pressed') === 'true');

  button.click();
  check('the button hides it', view.classList.contains('sidebar-hidden'));
  check('and remembers that', settings.current.showSidebar === false);
  check('the button reflects it', button.getAttribute('aria-pressed') === 'false' && /Show/.test(button.title),
    button.title);

  press('w');
  check('W brings it back', !view.classList.contains('sidebar-hidden') && settings.current.showSidebar);
  press('W');
  check('W hides it again', view.classList.contains('sidebar-hidden'));
  press('w', { ctrlKey: true });
  press('w', { metaKey: true });
  check('Ctrl/Cmd+W are left to the browser', view.classList.contains('sidebar-hidden'));
  press('w', {}, doc.querySelector('#library-select')!);
  check('typing in a field does not toggle it', view.classList.contains('sidebar-hidden'));
  press('w');
  check('and it can be shown again', !view.classList.contains('sidebar-hidden'));

  doc.querySelector<HTMLButtonElement>('#tabs [data-tab="settings"]')!.click();
  check('the toggle is not offered on the Settings tab', button.classList.contains('hidden'));
  doc.querySelector<HTMLButtonElement>('#tabs [data-tab="ride"]')!.click();
  check('and comes back on the Ride tab', !button.classList.contains('hidden'));
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
  check('the power tile shows the session average over the lap average',
    tile(0).rows.length === 2 && /^avg \d+$/.test(tile(0).rows[0]) && /^lap \d+$/.test(tile(0).rows[1]), tile(0).rows.join(' | '));
  check('the heart-rate tile shows the session average over the lap average',
    tile(2).rows.length === 2 && /^avg \d+$/.test(tile(2).rows[0]) && /^lap \d+$/.test(tile(2).rows[1]), tile(2).rows.join(' | '));
  check('the cadence tile shows speed over distance',
    tile(3).rows.length === 2 && /^\d+\.\d km\/h$/.test(tile(3).rows[0]) && /^\d+\.\d{2} km$/.test(tile(3).rows[1]),
    tile(3).rows.join(' | '));
  check('the cadence tile label is Cadence alone', tile(3).label === 'Cadence', tile(3).label);
  check('the target tile shows no delta or bias', !tile(1).rows.some((r) => /bias| W\b/.test(r)), tile(1).rows.join(' | '));
});

suite('sub-lines with emphasised parts', () => {
  const host = doc.createElement('div');
  const parts = [{ text: 'avg ' }, { text: '210', strong: true }, { text: ' · lap ' }, { text: '215', strong: true }];
  setParts(host, parts);
  check('the joined text is written', host.textContent === 'avg 210 · lap 215', host.textContent ?? '');
  check('each strong part becomes a <b>', host.querySelectorAll('b').length === 2);
  const before = Array.from(host.childNodes);
  setParts(host, parts.map((p) => ({ ...p })));
  const after = Array.from(host.childNodes);
  check('unchanged text leaves the nodes in place',
    before.length === after.length && before.every((n, i) => n === after[i]));

  const strong = (index: number) => Array.from(tile(index).root?.querySelectorAll('.tile-sub b') ?? [])
    .map((b) => b.textContent ?? '');
  check('the power averages are two emphasised numbers',
    strong(0).length === 2 && strong(0).every((t) => /^\d+$/.test(t)), strong(0).join(','));
  check('the heart-rate averages are two emphasised numbers',
    strong(2).length === 2 && strong(2).every((t) => /^\d+$/.test(t)), strong(2).join(','));
  const sessionOnly = averages(210, undefined);
  check('a session average alone is one row reading "avg 210"',
    sessionOnly.length === 1 && sessionOnly[0].map((p) => p.text).join('') === 'avg 210',
    JSON.stringify(sessionOnly));
  check('a session average alone has one strong part', sessionOnly[0].filter((p) => p.strong).length === 1);
  const cadenceBold = Array.from(tile(3).root?.querySelectorAll('.tile-sub b') ?? []).map((b) => b.textContent ?? '');
  check('speed and distance are emphasised numbers',
    cadenceBold.length === 2 && cadenceBold.every((t) => /^\d+\.\d+$/.test(t)), cadenceBold.join(','));
});

suite('bias, modes and seeking', () => {
  near('a 10% bias raises the target by 10%', biasedTarget, Math.round(biasBefore * 1.1), 2);
  check('free mode drops the ERG target', freeTarget === 0);
  check('free mode switches the trainer to simulation', simMode === 'sim', simMode);
  near('the grade reached the trainer', simGrade, 4.5, 0.01);
  check('the grade readout updated', doc.querySelector('#controls .readout')?.textContent !== undefined);
  check('ERG mode is restored', ergMode === 'erg', ergMode);

  const elapsedBefore = session.snapshot.elapsed;
  session.skipToNextBlock();
  check('skipping moves to the next block', session.snapshot.elapsed > elapsedBefore, String(session.snapshot.elapsed));
  check('the block index advanced', session.snapshot.segmentIndex === 1, String(session.snapshot.segmentIndex));

  const afterSkip = session.snapshot.elapsed;
  session.seek(-30);
  check('seeking back is refused', session.snapshot.elapsed === afterSkip, String(session.snapshot.elapsed));
  session.seek(30);
  check('+30 s moves the clock on by 30 s', session.snapshot.elapsed === afterSkip + 30, String(session.snapshot.elapsed));
});

suite('only next block and +30s move the workout clock', () => {
  const jump = Array.from(doc.querySelectorAll('#controls .group'))
    .find((g) => g.querySelector('label')?.textContent === 'Jump');
  const labels = Array.from(jump?.querySelectorAll('button') ?? []).map((b) => b.textContent);
  check('the Jump group holds exactly +30s and next block', labels.join(' ') === '+30s ▶|', labels.join(' '));

  // The ride is running, so the clock creeps on by itself; a seek would move it
  // by 10 s or more.
  const unmoved = (before: number) => Math.abs(session.snapshot.elapsed - before) < 1;
  const press = (key: string, shiftKey = false) =>
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));

  let before = session.snapshot.elapsed;
  press('ArrowRight'); press('ArrowRight', true); press('ArrowLeft'); press('ArrowLeft', true);
  check('arrow keys do not seek', unmoved(before), `${before} → ${session.snapshot.elapsed}`);
  const bias = session.snapshot.ergBias;
  press('ArrowUp');
  check('arrow up still nudges the bias', session.snapshot.ergBias > bias, `${bias} → ${session.snapshot.ergBias}`);
  press('ArrowDown');

  const canvas = doc.querySelector<HTMLCanvasElement>('#profile')!;
  before = session.snapshot.elapsed;
  for (const x of [5, 160, 315]) canvas.dispatchEvent(new dom.window.MouseEvent('click', { clientX: x, clientY: 100, bubbles: true }));
  check('clicking the workout graph does not seek', unmoved(before), `${before} → ${session.snapshot.elapsed}`);

  const index = session.snapshot.segmentIndex;
  const blocks = doc.querySelectorAll<HTMLElement>('#segment-list li');
  blocks.item(blocks.length - 1).click();
  blocks.item(0).click();
  check('clicking a block in the list does not seek', session.snapshot.segmentIndex === index,
    `${index} → ${session.snapshot.segmentIndex}`);
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

// --- starting a new ride must not quietly discard this one ------------------
hideSummary();
const startButton = () => Array.from(doc.querySelectorAll<HTMLButtonElement>('#controls button'))
  .find((b) => b.textContent === 'Start new ride');
const confirmOverlay = () => doc.querySelector('.confirm-overlay');
const clickIn = (root: Element, label: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === label)?.click();

const finishedSamples = session.snapshot.samples.length;
const labelWhenFinished = startButton()?.textContent;
startButton()?.click();
await wait(30);
const askedBeforeDiscard = confirmOverlay() !== null;
const confirmText = confirmOverlay()?.textContent ?? '';
if (confirmOverlay()) clickIn(confirmOverlay()!, 'Keep this ride');
await wait(30);

suite('a finished ride asks before being thrown away', () => {
  check('the button says what it will do', labelWhenFinished === 'Start new ride', labelWhenFinished ?? 'none');
  check('it asked first', askedBeforeDiscard);
  check('explaining that the ride has not been downloaded',
    /not been downloaded/.test(confirmText), confirmText.slice(0, 120));
  check('cancelling closed the dialog', confirmOverlay() === null);
  check('and kept the ride', session.snapshot.state === 'finished', session.snapshot.state);
  check('with its data intact', session.snapshot.samples.length === finishedSamples,
    `${finishedSamples} → ${session.snapshot.samples.length}`);
});

startButton()?.click();
await wait(30);
if (confirmOverlay()) clickIn(confirmOverlay()!, 'Discard and start new');
await wait(60);

suite('confirming starts a fresh ride', () => {
  check('the dialog closed', confirmOverlay() === null);
  check('a new ride is running', session.snapshot.state === 'running', session.snapshot.state);
  check('from the beginning', session.snapshot.elapsed < 2, String(session.snapshot.elapsed));
  check('with the old ride discarded', session.snapshot.samples.length < finishedSamples,
    String(session.snapshot.samples.length));
});

session.finish();
await wait(60);
hideSummary();
session.markExported();
startButton()?.click();
await wait(40);

suite('a ride that has been downloaded is discarded without asking', () => {
  check('no confirmation was needed', confirmOverlay() === null);
  check('and the new ride started', session.snapshot.state === 'running', session.snapshot.state);
});

session.finish();
await wait(60);
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

// --- a workout that is nothing but free riding ------------------------------
const freeEntry = LIBRARY.find((e) => e.id === 'free-ride-1h')!;
session.loadWorkout(parseZwo(freeEntry.zwo, { ftp: settings.current.ftp }));
session.setMode('erg'); // deliberately: the workout should override this
session.start();
await wait(1500);
const freeSnap = session.snapshot;
const freeRigMode = mock.rig.mode;
session.finish();
hideSummary();

suite('a free-ride workout overrides ERG mode', () => {
  near('it is one hour long', freeSnap.workout!.duration, 3600, 0.01);
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

const ftpBefore = settings.current.ftp;
settings.patch({ ftp: 300 });
session.loadWorkout(parseZwo(`<workout_file><name>Labels</name><workout>
  <Warmup Duration="600" PowerLow="0.60" PowerHigh="0.80"/>
  <SteadyState Duration="300" Power="0.50"/>
  <IntervalsT Repeat="5" OnDuration="60" OffDuration="60" OnPower="1.10" OffPower="0.50"/>
</workout></workout_file>`, { ftp: 300 }));
await wait(120);
const labelNode = () => doc.querySelector('#segment-list li .label');
const firstLabel = labelNode()?.textContent ?? '';
const nowText = doc.querySelector('#interval-bar .now')?.textContent ?? '';
const nextText = doc.querySelector('#interval-bar .next')?.textContent ?? '';
const intervalLabel = doc.querySelectorAll('#segment-list li .label').item(2)?.textContent ?? '';
const firstNode = doc.querySelector('#segment-list li');
settings.patch({ ftp: 200 });
await wait(120);

suite('blocks are labelled in watts and percent', () => {
  check('a ramp in the block list shows its watt range', firstLabel === '180–240 W (60–80%)', firstLabel);
  check('a named interval keeps its name in front', intervalLabel === '1/5 · 330 W (110%)', intervalLabel);
  check('the interval bar shows the current block in watts', nowText.includes('180–240 W (60–80%)'), nowText);
  check('and the next block', nextText === 'next: 150 W (50%) (5:00)', nextText);
  check('changing FTP rewrites the labels', labelNode()?.textContent === '120–160 W (60–80%)', labelNode()?.textContent ?? '');
  check('in place, without rebuilding the list', doc.querySelector('#segment-list li') === firstNode);
  check('and the interval bar follows',
    doc.querySelector('#interval-bar .now')?.textContent?.includes('120–160 W (60–80%)') ?? false,
    doc.querySelector('#interval-bar .now')?.textContent ?? '');
});
settings.patch({ ftp: ftpBefore });

suite('a dragged map still belongs to the ride view', () => {
  const panel = doc.querySelector<HTMLElement>('#view-ride .mini-map')!;
  const head = panel.querySelector<HTMLElement>('.mini-map-head')!;
  const pointer = (type: string, clientX: number, clientY: number) =>
    head.dispatchEvent(new dom.window.PointerEvent(type, { clientX, clientY, button: 0, bubbles: true }));
  pointer('pointerdown', 10, 10);
  pointer('pointermove', 60, 60);
  pointer('pointerup', 60, 60);
  check('the map was dragged', panel.classList.contains('floating'));
  doc.querySelector<HTMLButtonElement>('#tabs button[data-tab="settings"]')?.click();
  check('opening Settings hides the ride view', !doc.querySelector('#view-ride')?.classList.contains('active'));
  check('and the map is inside it, so it is hidden too', doc.querySelector('#view-ride')?.contains(panel) ?? false);
  doc.querySelector<HTMLButtonElement>('#tabs button[data-tab="ride"]')?.click();
  check('back on the ride view it is still where it was dragged', panel.classList.contains('floating'));
  head.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }));
});

suite('tabs and the devices panel', () => {
  const tabs = [...doc.querySelectorAll<HTMLButtonElement>('#tabs button')];
  check('there are three tabs: Ride, Devices, Settings',
    tabs.map((b) => b.textContent).join(',') === 'Ride,Devices,Settings', tabs.map((b) => b.textContent).join(','));
  doc.querySelector<HTMLButtonElement>('#tabs button[data-tab="settings"]')?.click();
  check('the settings view became active', doc.querySelector('#view-settings')?.classList.contains('active'));
  check('the ride view is hidden', !doc.querySelector('#view-ride')?.classList.contains('active'));
  check('the settings form rendered its number fields',
    doc.querySelectorAll('#settings-form input[type="number"]').length === 6,
    `got ${doc.querySelectorAll('#settings-form input[type="number"]').length}`);
  check('the settings form rendered its toggles',
    doc.querySelectorAll('#settings-form input[type="checkbox"]').length === 3,
    `got ${doc.querySelectorAll('#settings-form input[type="checkbox"]').length}`);
  const settingsText = doc.querySelector('#settings-form')?.textContent ?? '';
  check('the map is not configured from Settings',
    !settingsText.includes('Show the route map') && !settingsText.includes('Keep the map centred on you'));
  check('the devices panel is not on the settings page',
    !doc.querySelector('#view-settings')?.contains(doc.querySelector('#devices-panel')));

  doc.querySelector<HTMLButtonElement>('#tabs button[data-tab="devices"]')?.click();
  check('the devices view became active', doc.querySelector('#view-devices')?.classList.contains('active'));
  check('the settings view is hidden', !doc.querySelector('#view-settings')?.classList.contains('active'));
  check('the devices tab is marked active',
    doc.querySelector('#tabs button[data-tab="devices"]')?.classList.contains('active'));
  check('the devices panel lives on the devices page',
    doc.querySelector('#view-devices')?.contains(doc.querySelector('#devices-panel')) ?? false);
  check('the panel toggle is not offered on the Devices tab', doc.querySelector('#toggle-sidebar')?.classList.contains('hidden'));
  check('devices are managed from the devices page',
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

await mock.hrm.disconnect();
const chips = () => Array.from(doc.querySelectorAll<HTMLButtonElement>('#device-chips .chip'));
const [trainerChip, hrChip] = chips();
const chipsBefore = { trainer: trainerChip.disabled, hr: hrChip.disabled, hrTitle: hrChip.title };
const toastsBefore = doc.querySelectorAll('#toasts .toast-error').length;
hrChip.click();
await wait(0);

suite('a chip with nothing behind it pairs one', () => {
  check('the chips are buttons', chips().length === 2 && chips().every((c) => c.tagName === 'BUTTON'));
  check('a connected trainer chip is not clickable', chipsBefore.trainer);
  check('an empty HR chip is', !chipsBefore.hr && /Pair/.test(chipsBefore.hrTitle), chipsBefore.hrTitle);
  const errors = Array.from(doc.querySelectorAll('#toasts .toast-error')).slice(toastsBefore);
  check('clicking it goes through the same pairing as the Devices tab',
    errors.some((t) => /no Web Bluetooth/.test(t.textContent ?? '')),
    errors.map((t) => t.textContent).join(' | ') || 'no toast');
  check('and the chip is offered again once that fails',
    !hrChip.disabled && hrChip.textContent === 'No HR', `${hrChip.disabled} ${hrChip.textContent}`);
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
