import { setupDom } from './dom-setup';
setupDom();

const { smoothSamples, labelFits, hoverLines, ProfileGraph } = await import('../src/ui/profile-graph');
const { buildActivityFit } = await import('../src/activity/fit-export');
const { computeMetrics } = await import('../src/session/metrics');
const { decodeFit } = await import('../src/fit/decoder');
const { check, near, report, suite } = await import('./harness');
import type { Sample } from '../src/session/metrics';
import type { SessionSnapshot } from '../src/session/session';
import type { Segment, Workout } from '../src/workout/types';

const ride = (power: number[], hr?: (number | undefined)[]): Sample[] =>
  power.map((p, i) => ({ t: i + 1, power: p, targetPower: 0, heartRate: hr?.[i], distance: 0 }));

const spike = ride([200, 200, 500, 200, 200], [140, 140, 140, 140, 140]);

suite('graph traces are a trailing 3 s average', () => {
  const out = smoothSamples(spike, 3);
  near('the 500 W second is drawn at about 300 W', out[2].power, 300, 0.01);
  near('and so are the two seconds that still include it', out[4].power, 300, 0.01);
  near('the first second averages only itself', out[0].power, 200, 0.01);
  check('time is untouched', out.map((p) => p.t).join() === '1,2,3,4,5');
  near('steady heart rate stays steady', out[4].hr!, 140, 0.01);
});

suite('a window of 0 draws raw samples', () => {
  const out = smoothSamples(spike, 0);
  check('power is raw', out.map((p) => p.power).join() === '200,200,500,200,200');
  check('heart rate is raw', out.every((p) => p.hr === 140));
});

suite('heart-rate dropouts are not averaged in as zero', () => {
  const out = smoothSamples(ride([100, 100, 100, 100], [150, undefined, 0, 150]), 3);
  near('a gap next to readings keeps their value', out[2].hr!, 150, 0.01);
  check('a window with no readings has no heart rate', smoothSamples(ride([100, 100], [undefined, 0]), 3)
    .every((p) => p.hr === undefined));
});

suite('the export keeps the raw spike', () => {
  const bytes = buildActivityFit({
    startedAt: new Date('2026-10-18T07:00:00Z'), samples: spike, laps: [],
    metrics: computeMetrics(spike, 250), name: 'Spike',
  });
  const fit = decodeFit(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const records = fit.byName.get('record') ?? [];
  check('the spike second is recorded at 500 W', records[2]?.fields.power === 500, String(records[2]?.fields.power));
});

const block = (start: number, duration: number, powerStart?: number, powerEnd?: number): Segment => ({
  index: 0, start, duration, powerStart, powerEnd: powerEnd ?? powerStart,
  mode: powerStart === undefined ? 'free' : 'erg', kind: 'Test', label: 'x',
});

suite('a block label is drawn only when it fits', () => {
  check('fits with exactly 4 px clear each side', labelFits(40, 48));
  check('does not fit with 7 px to spare', !labelFits(40, 47));
});

suite('graph blocks are labelled in watts', () => {
  // ramp 60→80% for 10 min, then a 10 s steady block far too narrow for a label
  const segments = [block(0, 600, 0.6, 0.8), { ...block(600, 10, 0.75), index: 1 }];
  const workout: Workout = { name: 'g', duration: 610, segments, textEvents: [], source: 'zwo', ftpOverride: 300 };
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.append(canvas);
  document.body.append(host);
  const drawn: string[] = [];
  const realGetContext = canvas.getContext.bind(canvas);
  canvas.getContext = ((kind: string) => {
    const ctx = realGetContext(kind as '2d') as unknown as Record<string, unknown>;
    ctx.fillText = (text: string) => { drawn.push(text); };
    return ctx;
  }) as typeof canvas.getContext;
  const graph = new ProfileGraph(canvas, () => {});
  graph.setWorkout(workout);
  graph.render({ workout, elapsed: 0, samples: [], segmentIndex: 0, state: 'idle', targetPower: 0 } as unknown as SessionSnapshot);
  check('the ramp is labelled with its range', drawn.includes('180–240 W'), JSON.stringify(drawn));
  check('never with its midpoint', !drawn.includes('210') && !drawn.includes('210 W'), JSON.stringify(drawn));
  check('the narrow block gets no label', !drawn.includes('225 W'), JSON.stringify(drawn));
  host.remove();
});

suite('the hover readout shows the target under the cursor', () => {
  const ramp = block(0, 600, 0.6, 0.8);
  const lines = hoverLines(ramp, 150, undefined, 300);
  check('a quarter into the ramp the target is 195 W', lines.includes('target 195 W'), JSON.stringify(lines));
  check('and the range is shown', lines.includes('range 180–240 W'), JSON.stringify(lines));
  const steady = hoverLines(block(0, 600, 0.75), 300, { power: 230, heartRate: 150 }, 300);
  check('a steady block shows its target', steady.includes('target 225 W'), JSON.stringify(steady));
  check('and no range', !steady.some((l) => l.startsWith('range')), JSON.stringify(steady));
  check('what was ridden is still shown', steady.includes('actual 230 W · 150 bpm'), JSON.stringify(steady));
  check('a free block says so', hoverLines(block(0, 60), 30, undefined, 300).includes('free ride'));
});

report();
