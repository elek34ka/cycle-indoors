import { setupDom } from './dom-setup';
setupDom();

const { smoothSamples, labelFits, blockLabelY, hoverLines, ProfileGraph, liveDomain, wholeRideDomain } = await import('../src/ui/profile-graph');
const { buildActivityFit } = await import('../src/activity/fit-export');
const { computeMetrics } = await import('../src/session/metrics');
const { decodeFit } = await import('../src/fit/decoder');
const { check, near, report, suite } = await import('./harness');
const settingsModule = await import('../src/core/settings');
const zonesModule = await import('../src/core/zones');
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

report();
