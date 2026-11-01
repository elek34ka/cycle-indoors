import { readFileSync } from 'node:fs';
import { setupDom } from './dom-setup';
const dom = setupDom();

const { check, report, suite } = await import('./harness');
const {
  graphImageLayout, paintGraphImage, statsCardLayout, paintStatsImage, renderStatsImage, CARD_CREDIT,
} = await import('../src/ui/summary-image');
const { summaryValues, subText } = await import('../src/ui/summary-values');
const { computeMetrics } = await import('../src/session/metrics');
const { POWER_ZONES } = await import('../src/core/zones');
const { Course } = await import('../src/activity/course');
const { parseGpx } = await import('../src/activity/gpx');
type Sample = import('../src/session/metrics').Sample;
type StatsCardInput = import('../src/ui/summary-image').StatsCardInput;

const ride = (seconds: number, opts: { route?: boolean; hr?: boolean } = {}): Sample[] =>
  Array.from({ length: seconds }, (_, t) => ({
    t: t + 1, power: 210, targetPower: 0, cadence: 90, speed: 30, distance: (t + 1) * 8.3,
    ...(opts.hr === false ? {} : { heartRate: 150 }),
    ...(opts.route ? { lat: 46 + t * 1e-5, lon: 7, altitude: 500 + t * 0.1 } : {}),
  }));
const header = { title: 'Sweet Spot 3x15', subtitle: '2026-10-31 07:15 · 10:00 · FTP 250 W' };
const course = new Course(parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'Hilly loop'));

/** Every string drawn on any canvas while `fn` runs. */
function drawnText<T>(fn: () => T): { texts: string[]; result: T } {
  const proto = dom.window.HTMLCanvasElement.prototype;
  const real = proto.getContext;
  const texts: string[] = [];
  proto.getContext = function patched(this: HTMLCanvasElement, ...args: unknown[]) {
    const ctx = (real as (...a: unknown[]) => Record<string, unknown>).apply(this, args);
    ctx.fillText = (text: string) => { texts.push(text); };
    return ctx;
  } as typeof proto.getContext;
  try { return { texts, result: fn() }; } finally { proto.getContext = real; }
}

const graphInput = (samples: Sample[], withProfile: boolean) => ({
  header,
  graph: { workout: undefined, samples, elapsed: samples.length, ftp: 250, hrMax: 185, powerZones: POWER_ZONES, smoothWindow: 3 },
  ...(withProfile ? { profile: { course, ridden: 5000, header: 'Hilly loop · 5.00 km · ↑ 60 m' } } : {}),
});

suite('the graph image has a fixed size', () => {
  const plain = graphImageLayout(false);
  const route = graphImageLayout(true);
  check('1600 × 900 without a route', plain.width === 1600 && plain.height === 900, `${plain.width}×${plain.height}`);
  check('1600 × 1240 with one', route.width === 1600 && route.height === 1240, `${route.width}×${route.height}`);
  check('title band and workout graph without a route', plain.panels.map((p) => p.kind).join() === 'title,workout');
  check('and the profile under the graph with one', route.panels.map((p) => p.kind).join() === 'title,workout,elevation');
  const [, workout, elevation] = route.panels;
  check('the profile sits below the graph', elevation.rect.y >= workout.rect.y + workout.rect.h);
  check('every panel fits in the image', route.panels.every((p) => p.rect.y + p.rect.h <= route.height));

  const narrow = (() => { dom.window.innerWidth = 360; return paintGraphImage(graphInput(ride(600), true))!; })();
  const wide = (() => { dom.window.innerWidth = 2560; return paintGraphImage(graphInput(ride(600), true))!; })();
  check('the painted canvas is the layout\'s size', narrow.width === 1600 && narrow.height === 1240,
    `${narrow.width}×${narrow.height}`);
  check('whatever the window\'s width', narrow.width === wide.width && narrow.height === wide.height);
});

suite('the graph image draws the graph, and the profile only on a route', () => {
  const route = drawnText(() => paintGraphImage(graphInput(ride(600), true)));
  check('the title is drawn', route.texts.includes(header.title));
  check('the profile is drawn, with its header', route.texts.includes('Hilly loop · 5.00 km · ↑ 60 m') && route.texts.includes('km'));
  check('the workout graph\'s time axis is drawn', route.texts.includes('10:00'), JSON.stringify(route.texts.slice(0, 20)));
  const plain = drawnText(() => paintGraphImage(graphInput(ride(600), false)));
  check('no profile without a route', !plain.texts.includes('km'));
  check('no hover readout in either', ![...route.texts, ...plain.texts].some((t) => t.startsWith('actual ')));
});

const statsInput = (samples: Sample[], extra: Partial<StatsCardInput> = {}): StatsCardInput => {
  const m = computeMetrics(samples, 250, 185);
  return {
    header, values: summaryValues(m, 0), zones: m.zones, hrZones: m.hrZones,
    ...(m.avgHr === undefined ? { hrEmpty: 'No heart rate recorded' } : {}), ...extra,
  };
};
const texts = (input: StatsCardInput) =>
  statsCardLayout(input).items.flatMap((i) => (i.kind === 'text' ? [i.text] : []));

suite('the stats card holds what the summary shows', () => {
  const input = statsInput(ride(600, { route: true }), { header: { ...header, route: 'Route: Hilly loop' } });
  const shown = texts(input);
  check('the title, date line and route', [header.title, header.subtitle, 'Route: Hilly loop'].every((t) => shown.includes(t)));
  check('every summary value, labelled, with its unit or note', input.values.every((v) =>
    shown.includes(v.label) && shown.includes(v.value) && (subText(v) === undefined || shown.includes(subText(v)!))),
  JSON.stringify(input.values.filter((v) => !shown.includes(v.value))));
  check('both zone charts, titled', shown.includes('Power zones') && shown.includes('Heart-rate zones'));
  check('all 7 power zones and 5 heart-rate zones',
    input.zones.every((z) => shown.includes(`Z${z.zone} ${z.label}`)) && input.hrZones.every((z) => shown.includes(`Z${z.zone} ${z.label}`)));
  check('and the credit', shown.includes(CARD_CREDIT));
  check('a route ride has Climbed', shown.includes('Climbed'));

  const layout = statsCardLayout(input);
  check('1200 wide', layout.width === 1200);
  check('and everything inside it', layout.items.every((i) => i.y >= 0 && i.y < layout.height && i.x <= layout.width));
  const sizes = layout.items.flatMap((i) => (i.kind === 'text' ? [Number(/(\d+)px/.exec(i.font)?.[1])] : []));
  check('no text under 18 px', Math.min(...sizes) >= 18, String(Math.min(...sizes)));
});

suite('the stats card leaves out what the ride does not have', () => {
  const shown = texts(statsInput(ride(600, { hr: false })));
  check('no Climbed without a route', !shown.includes('Climbed'));
  check('no heart rate: says so', shown.includes('No heart rate recorded'));
  check('instead of the five heart-rate zones', !shown.includes('Z1 Recovery'));
  const card = paintStatsImage(statsInput(ride(600)))!;
  check('the painted canvas is the layout\'s size',
    card.width === 1200 && card.height === statsCardLayout(statsInput(ride(600))).height);
});

const png = await renderStatsImage(statsInput(ride(600)));
const proto = dom.window.HTMLCanvasElement.prototype;
const realToBlob = proto.toBlob;
proto.toBlob = function refuse(callback: BlobCallback) { callback(null); };
const refused = await renderStatsImage(statsInput(ride(600)));
proto.toBlob = function broken() { throw new Error('tainted'); };
const thrown = await renderStatsImage(statsInput(ride(600)));
proto.toBlob = realToBlob;
suite('the stats image is encoded as PNG', () => {
  check('a PNG blob', png?.type === 'image/png', png?.type);
  check('null when the browser gives no image', refused === null);
  check('null, not a throw, when encoding fails', thrown === null);
});

report();
