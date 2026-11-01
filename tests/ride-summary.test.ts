import { readFileSync } from 'node:fs';
import { setupDom } from './dom-setup';
const dom = setupDom();

const { check, report, suite } = await import('./harness');
const { showSummary } = await import('../src/ui/summary');
const { summaryValues, subText } = await import('../src/ui/summary-values');
const { computeMetrics } = await import('../src/session/metrics');
const { session } = await import('../src/session/session');
const { settings } = await import('../src/core/settings');
const { riddenFraction, ElevationGraph } = await import('../src/ui/elevation-graph');
const { ProfileGraph, hoverLines, hoverTarget } = await import('../src/ui/profile-graph');
const { courseStore } = await import('../src/activity/course-store');
const { parseGpx } = await import('../src/activity/gpx');
const { NO_HEART_RATE, IMAGES_NOTE, profileHeader } = await import('../src/ui/summary');
type SessionSnapshot = import('../src/session/session').SessionSnapshot;
type Sample = import('../src/session/metrics').Sample;
type Workout = import('../src/workout/types').Workout;

const doc = dom.window.document;
const { hhmmss: hhmm } = await import('../src/core/format');
/** "10:00" or "1:02:03" back to seconds. */
const seconds = (text: string) => text.split(':').map(Number).reduce((total, part) => total * 60 + part, 0);

/** `seconds` of steady riding; on a route the samples carry a position and a climb. */
function samples(seconds: number, opts: { route?: boolean; target?: number; hr?: boolean } = {}): Sample[] {
  return Array.from({ length: seconds }, (_, t) => ({
    t: t + 1,
    power: 200,
    targetPower: opts.target ?? 0,
    ...(opts.hr === false ? {} : { heartRate: 140 }),
    cadence: 90,
    speed: 30,
    distance: (t + 1) * 8.3,
    ...(opts.route ? { lat: 46 + t * 1e-5, lon: 7, altitude: 500 + t * 0.1 } : {}),
  }));
}

function snapshot(rideSamples: Sample[], extra: Partial<SessionSnapshot> = {}): SessionSnapshot {
  session.startedAt = new Date('2026-10-31T07:15:00');
  return { workout: undefined, samples: rideSamples, laps: [], elapsed: rideSamples.length, ...extra } as unknown as SessionSnapshot;
}

/** The grid as the rider reads it: label, value and the small text under it. */
const grid = () => Array.from(doc.querySelectorAll('#summary-overlay .summary-grid .cell')).map((c) => ({
  label: c.querySelector('span')?.textContent,
  value: c.querySelector('strong')?.textContent,
  sub: c.querySelector('em')?.textContent,
}));

suite('the grid is the list of summary values', () => {
  const route = samples(600, { route: true });
  showSummary(snapshot(route));
  const shown = grid();
  const values = summaryValues(computeMetrics(route, settings.current.ftp), 0);
  check('one cell per value', shown.length === values.length, `${shown.length} vs ${values.length}`);
  check('each cell shows its value', values.every((v, i) =>
    shown[i].label === v.label && shown[i].value === v.value && shown[i].sub === subText(v)));
});

suite('a route ride', () => {
  showSummary(snapshot(samples(600, { route: true })));
  const climbed = grid().find((c) => c.label === 'Climbed');
  check('shows Climbed with metres down', climbed?.value === '60' && climbed?.sub === '0 m down',
    JSON.stringify(climbed));
  check('shows Laps without a workout', grid().some((c) => c.label === 'Laps' && c.value === '1'));
});

suite('a free ride without a route', () => {
  showSummary(snapshot(samples(600, { hr: false })));
  const labels = grid().map((c) => c.label);
  check('no Climbed', !labels.includes('Climbed'));
  check('Laps, not On target', labels.includes('Laps') && !labels.includes('On target'));
  const hr = grid().find((c) => c.label === 'Avg HR');
  check('no heart rate reads -- with nothing under it', hr?.value === '--' && hr?.sub === undefined);
});

suite('a workout ride', () => {
  showSummary(snapshot(samples(600, { target: 200 })));
  const onTarget = grid().find((c) => c.label === 'On target');
  check('On target against the workout', onTarget?.value === '100%' && onTarget?.sub === 'vs. workout');
  const hr = grid().find((c) => c.label === 'Avg HR');
  check('heart rate carries its max', hr?.value === '140' && hr?.sub === 'max 140');
});

suite('how much of the route was ridden', () => {
  check('10 km of 25 km: 0.4', riddenFraction(10_000, 25_000) === 0.4);
  check('30 km of 25 km: all of it', riddenFraction(30_000, 25_000) === 1);
  check('nothing ridden: 0', riddenFraction(0, 25_000) === 0);
  check('a course of no length does not divide by zero', riddenFraction(500, 0) === 0);
});

suite('a graph stops following its canvas once disposed', () => {
  const Stub = globalThis.ResizeObserver;
  let live = 0;
  class Counting extends (Stub as unknown as { new (): { observe(): void; disconnect(): void } }) {
    observe(): void { live++; }
    disconnect(): void { live--; }
  }
  globalThis.ResizeObserver = Counting as unknown as typeof ResizeObserver;
  try {
    const host = doc.createElement('div');
    const a = doc.createElement('canvas');
    const b = doc.createElement('canvas');
    host.append(a, b);
    const graph = new ProfileGraph(a, { mode: 'whole' });
    const profile = new ElevationGraph(b);
    check('both observe their canvas', live === 2, String(live));
    graph.dispose();
    profile.dispose();
    check('and neither does after dispose()', live === 0, String(live));
  } finally {
    globalThis.ResizeObserver = Stub;
  }
});

/** Every string drawn on any canvas while `fn` runs. */
function drawnText(fn: () => void): string[] {
  const proto = dom.window.HTMLCanvasElement.prototype;
  const real = proto.getContext;
  const texts: string[] = [];
  proto.getContext = function patched(this: HTMLCanvasElement, ...args: unknown[]) {
    const ctx = (real as (...a: unknown[]) => Record<string, unknown>).apply(this, args);
    ctx.fillText = (text: string) => { texts.push(text); };
    return ctx;
  } as typeof proto.getContext;
  try { fn(); } finally { proto.getContext = real; }
  return texts;
}

const summaryGraph = () => doc.querySelectorAll('#summary-overlay .summary-graph canvas').length;
const summaryProfile = () => doc.querySelectorAll('#summary-overlay .summary-elevation canvas').length;
const hilly = parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'Hilly loop');

suite('the summary shows the ride on the workout graph', () => {
  courseStore.unload();
  showSummary(snapshot(samples(600, { target: 200 })));
  check('a ride without a route has the graph', summaryGraph() === 1);
  check('and no elevation profile, nor room for one', summaryProfile() === 0
    && doc.querySelector('#summary-overlay .summary-elevation') === null);

  showSummary(snapshot([]));
  check('an empty ride has neither', summaryGraph() === 0 && summaryProfile() === 0);
  check('and says nothing was recorded', /No data was recorded/.test(doc.querySelector('#summary-overlay')!.textContent ?? ''));
  check('and no zone charts', doc.querySelector('#summary-overlay .zone-chart') === null);
});

suite('a route ride shows the route under the graph', () => {
  const course = courseStore.load(hilly)!;
  const ride = samples(600, { route: true });
  const texts = drawnText(() => showSummary(snapshot(ride)));
  check('the route has elevation', course.hasElevation);
  check('the summary has the graph and the profile', summaryGraph() === 1 && summaryProfile() === 1);
  const m = computeMetrics(ride, settings.current.ftp);
  const header = profileHeader(course.name, m.distance, m.ascent);
  check('the profile is headed by the route, the distance ridden and the climb', texts.includes(header),
    JSON.stringify(texts.filter((t) => t.includes('·'))));
  check('which reads name · km · ↑ m', profileHeader('Alpe Loop', 18_400, 312) === 'Alpe Loop · 18.40 km · ↑ 312 m');
  check('and it is not the live elevation readout', !texts.some((t) => /^[+-]?\d+\.\d%$/.test(t)));

  const flat = courseStore.load({ ...hilly, points: hilly.points.map((pt) => ({ ...pt, ele: undefined })) });
  showSummary(snapshot(ride));
  check('a route without elevation gets no profile', flat !== undefined && !flat.hasElevation && summaryProfile() === 0);
  courseStore.unload();
});

suite('the route is the one loaded when the summary opened', () => {
  const name = courseStore.load(hilly)!.name;
  const texts = drawnText(() => showSummary(snapshot(samples(600, { route: true }))));
  courseStore.unload();
  check('unloading afterwards does not take the profile away', summaryProfile() === 1);
  check('drawn with the name it had', texts.some((t) => t.startsWith(`${name} · `)), name);
});

suite('reopening the summary lets go of the previous graphs', () => {
  const Stub = globalThis.ResizeObserver;
  let live = 0;
  class Counting extends (Stub as unknown as { new (): { observe(): void; disconnect(): void } }) {
    observe(): void { live++; }
    disconnect(): void { live--; }
  }
  globalThis.ResizeObserver = Counting as unknown as typeof ResizeObserver;
  try {
    courseStore.load(hilly);
    showSummary(snapshot(samples(600, { route: true })));
    check('a route ride observes two canvases', live === 2, String(live));
    showSummary(snapshot(samples(600, { route: true })));
    check('opening it again still observes two', live === 2, String(live));
    courseStore.unload();
    showSummary(snapshot(samples(600)));
    check('and a ride without a route just one', live === 1, String(live));
  } finally {
    globalThis.ResizeObserver = Stub;
    courseStore.unload();
  }
});

/** The zone charts as the rider reads them: title, then each row's text. */
const zoneCharts = () => Array.from(doc.querySelectorAll('#summary-overlay .zone-chart')).map((c) => ({
  title: c.querySelector('h3')?.textContent,
  rows: Array.from(c.querySelectorAll('.zone-row')).map((r) =>
    `${r.firstElementChild?.textContent} ${r.querySelector('.time')?.textContent}`),
  empty: c.querySelector('.empty')?.textContent,
}));

suite('time in zones: power and heart rate, each in its own chart', () => {
  const hrMax = settings.current.hrMax;
  settings.patch({ hrMax: 185 });
  try {
    const ride = samples(900).map((s, i) => ({ ...s, heartRate: i < 600 ? 140 : 160 }));
    showSummary(snapshot(ride));
    const [power, hr] = zoneCharts();
    check('two charts, titled', power?.title === 'Power zones' && hr?.title === 'Heart-rate zones',
      JSON.stringify(zoneCharts().map((c) => c.title)));
    check('heart rate: Z3 10:00 and Z4 5:00', hr.rows.includes('Z3 Tempo 10:00') && hr.rows.includes('Z4 Threshold 5:00'),
      JSON.stringify(hr.rows));
    check('and 0:00 in the other three', ['Z1 Recovery 0:00', 'Z2 Endurance 0:00', 'Z5 Maximum 0:00'].every((r) => hr.rows.includes(r)));
    const zones = computeMetrics(ride, settings.current.ftp).zones;
    check('power: the same times as computeMetrics gives', power.rows.join() ===
      zones.map((z) => `Z${z.zone} ${z.label} ${hhmm(z.seconds)}`).join(), JSON.stringify(power.rows));

    const dropped = samples(3600).map((s, i) => ({ ...s, heartRate: i < 2400 ? 150 : undefined }));
    showSummary(snapshot(dropped));
    const total = zoneCharts()[1].rows.map((r) => r.split(' ').at(-1)!).reduce((sum, t) => sum + seconds(t), 0);
    check('a strap that dropped out after 40 minutes: zones add up to 40:00', total === 2400, String(total));

    showSummary(snapshot(samples(600, { hr: false })));
    const none = zoneCharts()[1];
    check('no heart rate: says so instead of five empty zones', none.empty === NO_HEART_RATE && none.rows.length === 0,
      JSON.stringify(none));
    check('the power chart is still there', zoneCharts()[0].rows.length === 7);
  } finally {
    settings.patch({ hrMax });
  }
});

suite('hovering the summary graph reads out that moment', () => {
  // two 10-minute blocks at 60% and 80% of 250 W, ridden to the end
  const segments = [
    { index: 0, start: 0, duration: 600, powerStart: 0.6, powerEnd: 0.6, mode: 'erg', kind: 'Test', label: 'a' },
    { index: 1, start: 600, duration: 600, powerStart: 0.8, powerEnd: 0.8, mode: 'erg', kind: 'Test', label: 'b' },
  ];
  const workout = { name: 'Two blocks', duration: 1200, segments, textEvents: [], source: 'zwo', ftpOverride: 250 } as unknown as Workout;
  const ride = samples(1200).map((s) => ({ ...s, power: s.t > 600 ? 205 : 150, heartRate: s.t > 600 ? 150 : 130 }));
  courseStore.unload();
  const texts = drawnText(() => {
    showSummary(snapshot(ride, { workout }));
    const canvas = doc.querySelector<HTMLCanvasElement>('#summary-overlay .summary-graph canvas')!;
    // jsdom boxes are 320 wide, so the plot runs x 54–254 over 0–1200 s: 12:30 is at x 179.
    canvas.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 179, clientY: 60 }));
  });
  const { seg, sample } = hoverTarget({ workout, samples: ride }, 750);
  const expected = hoverLines(seg, 750, sample, 250);
  check('the readout is time, target, block duration and what was ridden',
    expected.join(' | ') === '12:30 | target 200 W | duration 10:00 | actual 205 W · 150 bpm', expected.join(' | '));
  check('and the summary graph draws exactly that', expected.every((line) => texts.includes(line)),
    JSON.stringify(texts.slice(-6)));
  const host = doc.createElement('div');
  const canvas = doc.createElement('canvas');
  host.append(canvas);
  const whole = new ProfileGraph(canvas, { mode: 'whole' });
  whole.setWorkout(workout);
  const finished = { workout, samples: ride, elapsed: 1200, segmentIndex: 1, targetPower: 200, state: 'finished' } as unknown as SessionSnapshot;
  check('a finished ride has no cursor and no target line', whole.view(finished).live === undefined);
  check('and the live graph still has both',
    new ProfileGraph(canvas).view(finished).live?.targetPower === 200 && new ProfileGraph(canvas).view(finished).live?.cursor === true);
  whole.dispose();
});

/** Downloads the page starts, by file name, with what was handed to the browser. */
const downloads: { name: string; blob: Blob }[] = [];
{
  let lastBlob: Blob | undefined;
  dom.window.URL.createObjectURL = (blob: Blob) => { lastBlob = blob; return 'blob:test'; };
  dom.window.HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    if (this.download) downloads.push({ name: this.download, blob: lastBlob! });
  };
}
const button = (text: string) => Array.from(doc.querySelectorAll<HTMLButtonElement>('#summary-overlay button'))
  .find((b) => b.textContent === text);
const toasts = () => Array.from(doc.querySelectorAll('.toast')).map((t) => t.textContent ?? '');
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

courseStore.unload();
showSummary(snapshot(samples(600)));
const offered = Boolean(button('Save graph image') && button('Save stats image'));
const noted = (doc.querySelector('#summary-overlay .summary-images-note')?.textContent ?? '') === IMAGES_NOTE;
button('Download .fit')!.click();
button('Save graph image')!.click();
await settle();
button('Save stats image')!.click();
await settle();
const [fit, graphPng, statsPng] = downloads.splice(0);

suite('the summary saves its graph and its stats as images', () => {
  check('both buttons are offered', offered);
  check('with the note that Strava will not take them from the app', noted);
  check('the .fit is named by the start stamp', fit?.name === 'cycle-indoors-20261031-0715.fit', fit?.name);
  check('the graph image shares that stamp', graphPng?.name === 'cycle-indoors-20261031-0715-graph.png', graphPng?.name);
  check('and so does the stats image', statsPng?.name === 'cycle-indoors-20261031-0715-stats.png', statsPng?.name);
  check('both are PNGs', graphPng?.blob.type === 'image/png' && statsPng?.blob.type === 'image/png');
});

showSummary(snapshot([]));
suite('an empty ride offers no images', () => {
  check('no Save graph image', !button('Save graph image'));
  check('no Save stats image', !button('Save stats image'));
});

showSummary(snapshot(samples(600)));
const proto = dom.window.HTMLCanvasElement.prototype;
const realToBlob = proto.toBlob;
proto.toBlob = function refuse(callback: BlobCallback) { setTimeout(() => callback(null), 0); };
button('Save stats image')!.click();
await settle();
proto.toBlob = realToBlob;
const refusedToast = toasts().some((t) => t.includes('Could not save the image'));
const savedNothing = downloads.length === 0;
const stillEnabled = button('Save stats image')?.disabled === false;
button('Download .fit')!.click();
const fitAfter = downloads.splice(0);

suite('a browser that will not make the image', () => {
  check('says the image could not be saved', refusedToast, JSON.stringify(toasts()));
  check('downloads nothing', savedNothing);
  check('leaves the button ready to try again', stillEnabled);
  check('and Download .fit still works', fitAfter.length === 1 && fitAfter[0].name.endsWith('.fit'));
  check('as does Upload to Strava, still offered',
    doc.querySelector('#summary-overlay .strava-slot')?.textContent === 'Upload to Strava');
});


// The rider's own zones, from Settings.
const Z2_78 = [0.55, 0.78, 0.90, 1.05, 1.20, 1.50];
const before = { ftp: settings.current.ftp, hrMax: settings.current.hrMax };
settings.patch({ ftp: 200, hrMax: 185, powerZoneBounds: Z2_78, hrZoneBounds: [0.60, 0.784, 0.80, 0.90] });
const at = (rideSamples: Sample[], power: number, hr: number) => rideSamples.map((s) => ({ ...s, power, heartRate: hr }));
courseStore.unload();
showSummary(snapshot(at(samples(1200), 154, 140)));
const customCharts = zoneCharts();
// The stats image's text, as painted.
const painted: string[] = [];
{
  const realGetContext = proto.getContext;
  proto.getContext = function recording(this: HTMLCanvasElement, ...args: unknown[]) {
    const ctx = (realGetContext as (...a: unknown[]) => Record<string, unknown>).apply(this, args);
    ctx.fillText = (text: string) => { painted.push(text); };
    return ctx;
  } as never;
  button('Save stats image')!.click();
  await settle();
  proto.getContext = realGetContext;
  downloads.splice(0);
}
/** "Z2 Endurance 20:00" for each zone row painted under `title`. */
const paintedRows = (title: string, count: number) => {
  const from = painted.indexOf(title) + 1;
  return Array.from({ length: count }, (_, k) => `${painted[from + 2 * k]} ${painted[from + 2 * k + 1]}`);
};
const override = { name: 'Own FTP', duration: 600, segments: [], textEvents: [], source: 'zwo', ftpOverride: 300 } as unknown as Workout;
showSummary(snapshot(at(samples(600), 230, 140), { workout: override }));
const overrideCharts = zoneCharts();
settings.patch({ powerZoneBounds: null, hrZoneBounds: null });
showSummary(snapshot(at(samples(1200), 154, 140)));
const formulaCharts = zoneCharts();
settings.patch(before);

suite('the zone charts use the rider\'s zones', () => {
  const [power, hr] = customCharts;
  check('FTP 200, Z2 to 78 %, 20 min at 154 W: power Z2 20:00', power.rows.includes('Z2 Endurance 20:00'), JSON.stringify(power.rows));
  check('and nothing in Z3', power.rows.includes('Z3 Tempo 0:00'));
  check('max HR 185, HR Z2 to 78.4 %, 140 bpm: HR Z2 20:00', hr.rows.includes('Z2 Endurance 20:00'), JSON.stringify(hr.rows));
  check('and nothing in HR Z3', hr.rows.includes('Z3 Tempo 0:00'));
  check('the stats image paints the same power zones as the chart',
    paintedRows('Power zones', 7).join() === power.rows.join(), JSON.stringify(paintedRows('Power zones', 7)));
  check('and the same heart-rate zones', paintedRows('Heart-rate zones', 5).join() === hr.rows.join(),
    JSON.stringify(paintedRows('Heart-rate zones', 5)));
  check('a workout with its own FTP of 300: 230 W is Z2', overrideCharts[0].rows.includes('Z2 Endurance 10:00'),
    JSON.stringify(overrideCharts[0].rows));
  check('back on the formula, the same ride is Z3', formulaCharts[0].rows.includes('Z3 Tempo 20:00')
    && formulaCharts[1].rows.includes('Z3 Tempo 20:00'), JSON.stringify(formulaCharts.map((c) => c.rows)));
});

report();
