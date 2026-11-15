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

report();
