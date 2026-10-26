import { setupDom } from './dom-setup';
setupDom();

const { smoothSamples, labelFits, blockLabelY, hoverLines, ProfileGraph } = await import('../src/ui/profile-graph');
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
  const graph = new ProfileGraph(canvas);
  graph.setWorkout(workout);
  graph.render({ workout, elapsed: 0, samples: [], segmentIndex: 0, state: 'idle', targetPower: 0 } as unknown as SessionSnapshot);
  check('the ramp is labelled with its range', drawn.includes('180–240 W'), JSON.stringify(drawn));
  check('never with its midpoint', !drawn.includes('210') && !drawn.includes('210 W'), JSON.stringify(drawn));
  check('the narrow block gets no label', !drawn.includes('225 W'), JSON.stringify(drawn));
  host.remove();
});

suite('a block label is placed inside the block', () => {
  // the top edge of a block from (x0, yA) to (x1, yB), as drawSegment draws it
  const edge = (x0: number, x1: number, yA: number, yB: number) => (x: number) => yA + ((yB - yA) * (x - x0)) / (x1 - x0);
  // the label's top, for 12 px text drawn baseline-middle
  const top = (y: number) => y - 6;

  check('a steady block keeps its label 11 px below the top', blockLabelY(0, 200, 100, 100, 60, 300) === 111);

  const rising = blockLabelY(0, 200, 120, 60, 60, 300)!;
  const up = edge(0, 200, 120, 60);
  check('a rising ramp puts the label below the edge at its left end', top(rising) >= up(70), `${top(rising)} vs ${up(70)}`);
  check('and at its right end', top(rising) >= up(130), `${top(rising)} vs ${up(130)}`);

  const falling = blockLabelY(0, 200, 60, 120, 60, 300)!;
  const down = edge(0, 200, 60, 120);
  check('a falling ramp is placed by its lower, right-hand side',
    top(falling) >= down(130) && top(falling) >= down(70), `${top(falling)} vs ${down(130)}`);

  // 40% → 120% FTP: the ends are far apart, so the high end's height would put
  // the label well above the block in its middle
  const steep = blockLabelY(0, 200, 160, 20, 60, 300)!;
  check('a steep ramp is placed by its low side', steep === edge(0, 200, 160, 20)(70) + 11, String(steep));
  check('which is not the height of its high end', steep > 20 + 11, String(steep));

  check('a block with less than a line of room shows no label', blockLabelY(0, 200, 290, 290, 60, 300) === undefined);
  check('one with exactly a line of room does', blockLabelY(0, 200, 282, 282, 60, 300) === 293);
  check('a zero-width block does not divide by zero', blockLabelY(10, 10, 100, 100, 0, 300) === 111);
});

suite('a ramp on the graph is labelled on its colour', () => {
  // Canvas boxes are 320x200 under jsdom, so the plot runs x 54–254, y 16–174.
  const plot = { x: 54, y: 16, w: 200, h: 158 };
  const drawnAt = (powerStart: number, powerEnd: number, ftp: number) => {
    const segments = [block(0, 600, powerStart, powerEnd)];
    const workout: Workout = { name: 'r', duration: 600, segments, textEvents: [], source: 'zwo', ftpOverride: ftp };
    const host = document.createElement('div');
    const canvas = document.createElement('canvas');
    host.append(canvas);
    document.body.append(host);
    const calls: { text: string; x: number; y: number }[] = [];
    const realGetContext = canvas.getContext.bind(canvas);
    canvas.getContext = ((kind: string) => {
      const ctx = realGetContext(kind as '2d') as unknown as Record<string, unknown>;
      ctx.fillText = (text: string, x: number, y: number) => { calls.push({ text, x, y }); };
      return ctx;
    }) as typeof canvas.getContext;
    const graph = new ProfileGraph(canvas);
    graph.setWorkout(workout);
    graph.render({ workout, elapsed: 0, samples: [], segmentIndex: 0, state: 'idle', targetPower: 0 } as unknown as SessionSnapshot);
    host.remove();
    // the graph's own vertical scale: 1.3× FTP, or 12% above the workout's peak
    const ceiling = Math.max(1.3, Math.max(powerStart, powerEnd) * 1.12);
    const yOf = (r: number) => plot.y + plot.h - (r / ceiling) * plot.h;
    const edge = (x: number) => yOf(powerStart) + ((yOf(powerEnd) - yOf(powerStart)) * (x - plot.x)) / plot.w;
    return { calls, edge };
  };

  const { calls, edge } = drawnAt(0.5, 0.6, 200);
  const label = calls.find((c) => c.text === '100–120 W');
  check('a 100–120 W ramp is labelled', label !== undefined, JSON.stringify(calls.map((c) => c.text)));
  if (label) {
    // the fake context measures every string as 40 px wide
    check('below its top edge at both ends of the label',
      label.y - 6 >= edge(label.x - 20) && label.y - 6 >= edge(label.x + 20),
      `${label.y - 6} vs ${edge(label.x - 20)}, ${edge(label.x + 20)}`);
    check('and above the foot of the graph', label.y + 7 <= plot.y + plot.h, String(label.y));
  }

  const steep = drawnAt(0.4, 1.2, 300);
  const steepLabel = steep.calls.find((c) => c.text === '120–360 W');
  check('a steep 120–360 W ramp is labelled', steepLabel !== undefined,
    JSON.stringify(steep.calls.map((c) => c.text)));
  if (steepLabel) {
    check('on its colour, not up at the height of its high end',
      steepLabel.y - 6 >= steep.edge(steepLabel.x - 20) && steepLabel.y - 6 >= steep.edge(steepLabel.x + 20),
      `${steepLabel.y - 6} vs ${steep.edge(steepLabel.x - 20)}`);
  }
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

suite('the hover readout shows the block duration', () => {
  const five = hoverLines(block(0, 300, 0.75), 120, undefined, 300);
  check('two minutes into a 5-minute block it is the whole 5:00', five.includes('duration 5:00'), JSON.stringify(five));
  const long = hoverLines(block(0, 4500, 0.6), 600, undefined, 300);
  check('an hour or more is written h:mm:ss', long.includes('duration 1:15:00'), JSON.stringify(long));
  const ramp = hoverLines(block(0, 600, 0.6, 0.8), 150, undefined, 300);
  check('a ramp shows its own length beside target and range',
    ramp.includes('duration 10:00') && ramp.includes('target 195 W') && ramp.includes('range 180–240 W'),
    JSON.stringify(ramp));
  const free = hoverLines(block(0, 600), 30, undefined, 300);
  check('a free block shows its duration too', free.includes('free ride') && free.includes('duration 10:00'),
    JSON.stringify(free));
  const none = hoverLines(undefined, 700, { power: 200 }, 300);
  check('no block, no duration', !none.some((l) => l.startsWith('duration')), JSON.stringify(none));
  const all = hoverLines(block(0, 600, 0.6, 0.8), 150, { power: 200 }, 300);
  check('lines run time, target, range, duration, actual',
    JSON.stringify(all) === JSON.stringify(['2:30', 'target 195 W', 'range 180–240 W', 'duration 10:00', 'actual 200 W']),
    JSON.stringify(all));
});

report();
