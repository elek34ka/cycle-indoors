import { setupDom } from './dom-setup';
const dom = setupDom();
// Settings saved before the smoother existed.
dom.window.localStorage.setItem('cycle-indoors.settings.v1', JSON.stringify({ ftp: 250 }));

const {
  PRESETS, normaliseParams, validateParams, routeProblem, resample, routeDistances, removeSpikes,
  savitzkyGolay, smoothProfile, profileStats, gradients, valueAt,
} = await import('../src/activity/smoothing');
const { buildGpx, smoothedTrackPoints } = await import('../src/activity/gpx-export');
const { parseGpx } = await import('../src/activity/gpx');
const { parseFitActivity } = await import('../src/activity/fit-activity');
const { buildActivityFit } = await import('../src/activity/fit-export');
const { computeMetrics } = await import('../src/session/metrics');
const { readFileSync } = await import('node:fs');
const { settings } = await import('../src/core/settings');
const { check, near, report, suite } = await import('./harness');
import type { Sample } from '../src/session/metrics';
import type { ActivityTrack, TrackPoint } from '../src/activity/types';
import type { SmoothingParams } from '../src/activity/smoothing';

/** Metres per degree of latitude on the haversine sphere, so a point `d` metres
 *  north of the start sits exactly `d` metres along the route. */
const M_PER_DEG = (6371008.8 * Math.PI) / 180;

function trackOf(samples: { d: number; ele?: number }[], name = 'Test'): ActivityTrack {
  const points: TrackPoint[] = samples.map((s) => ({ lat: 50 + s.d / M_PER_DEG, lon: 19, ele: s.ele, distance: s.d }));
  return {
    name, source: 'gpx', points, distance: samples[samples.length - 1].d, ascent: 0, descent: 0,
    hasPower: false, hasHr: false, hasElevation: true,
  };
}

/** A route sampled every `every` metres from 0 to `length`, at the height `f` gives. */
function route(length: number, f: (d: number) => number, every = 10): ActivityTrack {
  const samples: { d: number; ele: number }[] = [];
  for (let d = 0; d <= length + 1e-9; d += every) samples.push({ d, ele: f(d) });
  return trackOf(samples);
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hills, GPS noise, uneven logging and the occasional absurd altitude. */
function noisyRoute(seed: number): ActivityTrack {
  const rand = mulberry32(seed);
  const length = 3000 + rand() * 9000;
  const a1 = 10 + rand() * 60;
  const a2 = 5 + rand() * 30;
  const p1 = 800 + rand() * 3000;
  const p2 = 200 + rand() * 600;
  const samples: { d: number; ele: number }[] = [];
  for (let d = 0; d < length; d += 3 + rand() * 15) {
    let ele = 200 + a1 * Math.sin((d / p1) * 2 * Math.PI) + a2 * Math.sin((d / p2) * 2 * Math.PI);
    ele += (rand() - 0.5) * 4;
    if (rand() < 0.01) ele += (rand() - 0.5) * 80;
    samples.push({ d, ele });
  }
  return trackOf(samples);
}

const MEDIUM = PRESETS.medium;
const EPS = 1e-9;

suite('parameters', () => {
  check('an even window is raised to the next odd', normaliseParams({ ...MEDIUM, window: 8 }).window === 9);
  check('51 stays 51', normaliseParams({ ...MEDIUM, window: 51 }).window === 51);
  check('an odd window is kept', normaliseParams({ ...MEDIUM, window: 7 }).window === 7);
  check('min ≥ max is refused',
    validateParams({ ...MEDIUM, minGradient: 0, maxGradient: 0 }) === 'Min gradient must be below max gradient');
  const outOfRange: [keyof SmoothingParams, number][] = [
    ['spacing', 4], ['spacing', 51], ['spikeThreshold', 1], ['spikeThreshold', 11], ['window', 1], ['window', 52],
    ['maxChange', 0], ['maxChange', 6], ['minGradient', -31], ['minGradient', 1], ['maxGradient', -1], ['maxGradient', 31],
  ];
  for (const [key, value] of outOfRange) {
    check(`${key} = ${value} is refused`, validateParams({ ...MEDIUM, [key]: value }) !== undefined);
  }
  check('an even window of 8 is valid (it becomes 9)', validateParams({ ...MEDIUM, window: 8 }) === undefined);
  for (const [name, preset] of Object.entries(PRESETS)) {
    check(`the ${name} preset is valid`, validateParams(preset) === undefined, validateParams(preset));
    check(`the ${name} window is odd`, preset.window % 2 === 1);
  }
});

suite('which routes can be smoothed', () => {
  check('a normal route is fine', routeProblem(route(1000, () => 100)) === undefined);
  check('one point is refused', routeProblem(trackOf([{ d: 0, ele: 1 }])) !== undefined);
  check('no elevation is refused',
    routeProblem(trackOf([{ d: 0 }, { d: 100 }])) === 'This route has no elevation to smooth');
});

suite('resampling', () => {
  const climb = route(1000, (d) => 100 + d * 0.1, 8);
  const dist = routeDistances(climb.points);
  const r = resample(dist, climb.points.map((p) => p.ele), 10);
  check('1 km at 10 m gives 101 samples', r.distances.length === 101, `got ${r.distances.length}`);
  near('the step is 10 m', r.step, 10, 1e-6);
  near('the last sample sits at the total distance', r.distances[100], dist[dist.length - 1], 1e-9);
  check('heights are interpolated exactly',
    r.elevations.every((e, i) => Math.abs(e - (100 + r.distances[i] * 0.1)) < 1e-6));

  const uneven = route(1005, () => 100, 5);
  const ru = resample(routeDistances(uneven.points), uneven.points.map((p) => p.ele), 10);
  check('a length that does not divide evenly shrinks the step instead', ru.step <= 10 && ru.step > 9.9);

  // A FIT file whose own distance field disagrees with the coordinates.
  const fitLike = route(1000, (d) => 100 + d * 0.05);
  fitLike.points.forEach((p) => { p.distance *= 1.1; });
  fitLike.source = 'fit';
  const profile = smoothProfile(fitLike, MEDIUM);
  near('the profile follows haversine, not the FIT distance field',
    profile.distances[profile.distances.length - 1], 1000, 0.5);

  const gaps = trackOf([{ d: 0, ele: 100 }, { d: 50 }, { d: 100, ele: 110 }]);
  const rg = resample(routeDistances(gaps.points), gaps.points.map((p) => p.ele), 10);
  near('a point without elevation is interpolated across', rg.elevations[5], 105, 0.05);
});

suite('spike removal', () => {
  const flat = route(2000, (d) => (d === 1000 ? 140 : 100));
  const smoothed = smoothProfile(flat, MEDIUM).smoothed;
  check('one point 40 m up leaves the road within 0.5 m',
    smoothed.every((e) => Math.abs(e - 100) <= 0.5), `worst ${Math.max(...smoothed.map((e) => Math.abs(e - 100)))}`);

  const run = route(2000, (d) => (d >= 1000 && d < 1030 ? 130 : 100));
  const runSmoothed = smoothProfile(run, MEDIUM).smoothed;
  check('a 30 m run of bad points is removed', runSmoothed.every((e) => Math.abs(e - 100) <= 0.5),
    `worst ${Math.max(...runSmoothed.map((e) => Math.abs(e - 100)))}`);

  const climb = Array.from({ length: 201 }, (_, i) => 100 + i);
  const kept = removeSpikes(climb, 10, 3);
  check('a real 10% climb is left alone', kept.every((v, i) => v === climb[i]));

  const rand = mulberry32(7);
  const noise = Array.from({ length: 300 }, () => 100 + (rand() * 2 - 1));
  const noiseKept = removeSpikes(noise, 10, 2);
  check('±1 m of noise on a flat road flags nothing', noiseKept.every((v, i) => v === noise[i]));
});

suite('Savitzky–Golay', () => {
  const line = Array.from({ length: 60 }, (_, i) => 3 + 0.7 * i);
  check('a straight line passes through unchanged',
    savitzkyGolay(line, 9).every((v, i) => Math.abs(v - line[i]) < 1e-6));
  const parabola = Array.from({ length: 60 }, (_, i) => 2 - 0.3 * i + 0.05 * i * i);
  check('a parabola passes through unchanged, ends included',
    savitzkyGolay(parabola, 9).every((v, i) => Math.abs(v - parabola[i]) < 1e-6));

  const rand = mulberry32(11);
  const clean = Array.from({ length: 400 }, (_, i) => 100 + 30 * Math.sin(i / 40));
  const noisy = clean.map((v) => v + (rand() - 0.5) * 4);
  const rms = (a: number[]) => Math.sqrt(a.reduce((s, v, i) => s + (v - clean[i]) ** 2, 0) / a.length);
  check('noise is reduced', rms(savitzkyGolay(noisy, 9)) < rms(noisy) * 0.6,
    `${rms(savitzkyGolay(noisy, 9))} vs ${rms(noisy)}`);

  const summit = Array.from({ length: 201 }, (_, i) => 100 + 50 * Math.exp(-(((i * 10 - 1000) / 150) ** 2)));
  const sg = savitzkyGolay(summit, 9);
  const ma = summit.map((_, i) => {
    const w = summit.slice(Math.max(0, i - 4), i + 5);
    return w.reduce((s, v) => s + v, 0) / w.length;
  });
  const sgLoss = 150 - Math.max(...sg);
  const maLoss = 150 - Math.max(...ma);
  check('a summit keeps its height within 1 m', Math.abs(sgLoss) < 1, `lost ${sgLoss}`);
  check('a moving average of the same width loses more', maLoss > Math.abs(sgLoss), `${maLoss} vs ${sgLoss}`);
  check('a series shorter than the window is still smoothed safely', savitzkyGolay([1, 2, 3, 4], 9).length === 4);
});

suite('gradient limits', () => {
  const wall = route(2200, (d) => (d < 1000 ? 100 : d < 1200 ? 100 + (d - 1000) * 0.3 : 160));
  const pw = smoothProfile(wall, MEDIUM);
  check('a 30% wall never exceeds 15%', pw.smoothedGradient.every((g) => g <= 15 + EPS),
    `max ${Math.max(...pw.smoothedGradient)}`);
  check('the wall still climbs', pw.stats.smoothed.maxGradient > 10);

  const drop = route(2000, (d) => (d < 1000 ? 300 : d < 1500 ? 300 - (d - 1000) * 0.18 : 210));
  const pd = smoothProfile(drop, MEDIUM);
  const steepest = Math.min(...pd.smoothedGradient);
  check('an −18% descent never goes below −10% with min −10', smoothProfile(drop, { ...MEDIUM, minGradient: -10 })
    .smoothedGradient.every((g) => g >= -10 - EPS));
  check('with −15% the descent is capped at −15%', steepest >= -15 - EPS, `min ${steepest}`);

  const step = route(2000, (d) => (d < 1000 ? 100 : 100 + (d - 1000) * 0.1));
  const ps = smoothProfile(step, MEDIUM);
  const delta = (MEDIUM.maxChange * ps.step) / 10;
  const diffs = ps.smoothedGradient.slice(1).map((g, i) => Math.abs(g - ps.smoothedGradient[i]));
  check('no neighbouring pair changes by more than Δ', diffs.every((d) => d <= delta + EPS), `max ${Math.max(...diffs)}`);
  const lastFlat = ps.smoothedGradient.findIndex((g) => g > 0.01);
  const firstFull = ps.smoothedGradient.findIndex((g) => g >= 9.99);
  const ramp = (firstFull - lastFlat) * ps.step;
  check('0% to 10% takes at least 100 m', firstFull > 0 && ramp >= 100 - EPS, `took ${ramp} m`);

  const big = route(6000, (d) => (d < 1000 ? 100 : d < 2500 ? 100 + (d - 1000) * 0.2 : 400));
  const pb = smoothProfile(big, MEDIUM);
  near('a clipped 300 m climb still finishes at its height', pb.smoothed[pb.smoothed.length - 1], 400, 1);
  check('and needs no warning', pb.anchorShortfall === undefined);
  check('and still respects the 15% cap', pb.smoothedGradient.every((g) => g <= 15 + EPS));

  const tight = route(2000, (d) => 100 + d * 0.1);
  const pt = smoothProfile(tight, { ...MEDIUM, maxGradient: 5 });
  check('2 km / 200 m at max 5% reports a shortfall over 1 m',
    pt.anchorShortfall !== undefined && pt.anchorShortfall > 1, `got ${pt.anchorShortfall}`);
  // Anchors are the 50 m medians, 102.5 m and 297.5 m: 195 m wanted, 100 m allowed.
  near('the shortfall is what the limit costs', pt.anchorShortfall ?? 0, 95, 0.5);
});

suite('limits hold on random noisy routes', () => {
  let failures = 0;
  let detail = '';
  for (let seed = 1; seed <= 200; seed++) {
    const track = noisyRoute(seed);
    for (const [name, preset] of Object.entries(PRESETS)) {
      const p = smoothProfile(track, preset);
      const delta = (preset.maxChange * p.step) / 10;
      const g = p.smoothedGradient;
      const inRange = g.every((v) => v <= preset.maxGradient + EPS && v >= preset.minGradient - EPS);
      const gradual = g.every((v, i) => i === 0 || Math.abs(v - g[i - 1]) <= delta + 1e-7);
      const anchored = Math.abs(p.smoothed[0] - p.anchors.start) < 0.1;
      const finished = p.anchorShortfall !== undefined || Math.abs(p.smoothed[p.smoothed.length - 1] - p.anchors.finish) <= 1;
      if (!(inRange && gradual && anchored && finished)) {
        failures++;
        if (!detail) detail = `seed ${seed} ${name}: range ${inRange} gradual ${gradual} start ${anchored} finish ${finished}`;
      }
    }
  }
  check('200 routes × 3 presets: every segment inside the limits, start and finish anchored', failures === 0, detail);
});

suite('before and after figures', () => {
  const hill = route(3000, (d) => (d <= 1000 ? 100 : d <= 2000 ? 100 + (d - 1000) * 0.1 : 200 - (d - 2000) * 0.1));
  const stats = smoothProfile(hill, MEDIUM).stats.original;
  near('ascent', stats.ascent, 100, 0.01);
  near('descent', stats.descent, 100, 0.01);
  near('max gradient', stats.maxGradient, 10, 0.01);
  near('min gradient', stats.minGradient, -10, 0.01);

  const direct = profileStats([0, 1, 1, 3], gradients([0, 1, 1, 3], 10), 10, { start: 0, finish: 2 });
  near('largest change per 10 m', direct.maxChange, 20, 1e-9);
  near('finish shift', direct.finishShift, 1, 1e-9);

  const noisy = smoothProfile(noisyRoute(42), MEDIUM);
  check('smoothing does not add climbing', noisy.stats.smoothed.ascent <= noisy.stats.original.ascent,
    `${noisy.stats.smoothed.ascent} vs ${noisy.stats.original.ascent}`);
  check('the largest change is within Medium\'s limit', noisy.stats.smoothed.maxChange <= 1 + 1e-7,
    `got ${noisy.stats.smoothed.maxChange}`);
  check('the original was much rougher', noisy.stats.original.maxChange > 5);
});

/** Write the smoothed GPX, load it back the way the app does, and compare. */
function roundTrip(label: string, track: ActivityTrack): void {
  const profile = smoothProfile(track, MEDIUM);
  const xml = buildGpx(track.name, smoothedTrackPoints(track, profile));
  const back = parseGpx(xml, 'fallback');
  const source = track.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  check(`${label}: same number of points`, back.points.length === source.length,
    `${back.points.length} vs ${source.length}`);
  check(`${label}: same coordinates`, back.points.every((p, i) =>
    Math.abs(p.lat - source[i].lat) < 1e-7 && Math.abs(p.lon - source[i].lon) < 1e-7));
  near(`${label}: same total distance`, back.distance, routeDistances(source).at(-1)!, 0.5);
  const worst = Math.max(...back.points.map((p) => Math.abs(p.ele! - valueAt(profile, profile.smoothed, p.distance))));
  check(`${label}: heights match the smoothed profile within 0.1 m`, worst <= 0.1, `worst ${worst}`);
  check(`${label}: no times or sensor extensions`, !/<time>|<extensions>/.test(xml));
  check(`${label}: the track keeps its name`, back.name === track.name, back.name);
}

suite('GPX export', () => {
  const sample = parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'sample');
  check('the sample has sensor data to drop', sample.hasPower && sample.hasHr);
  roundTrip('sample GPX', sample);

  const samples: Sample[] = [];
  for (let t = 1; t <= 300; t++) {
    samples.push({
      t, power: 240, targetPower: 240, heartRate: 150, cadence: 88, speed: 28.8, distance: t * 8,
      lat: 50.06 + t * 0.0001, lon: 19.94 + t * 0.00005, altitude: 220 + t * 0.4 + ((t * 7919) % 5) - 2,
    });
  }
  const bytes = buildActivityFit({ startedAt: new Date('2026-10-01T08:00:00Z'), samples, laps: [], metrics: computeMetrics(samples, 250), name: 'FIT ride' });
  const fit = parseFitActivity(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'FIT ride');
  check('the FIT source is a FIT track', fit.source === 'fit');
  roundTrip('FIT activity', fit);

  const awkward = route(1000, (d) => 100 + d * 0.02);
  awkward.name = 'Up & <over> "the" hill';
  roundTrip('awkward name', awkward);
});

suite('remembered parameters', () => {
  const loaded = settings.current.routeSmoothing;
  check('older settings load with Medium', loaded.preset === 'medium' && loaded.window === PRESETS.medium.window);
  check('and keep what they had', settings.current.ftp === 250);
  settings.patch({ routeSmoothing: { ...PRESETS.strong, preset: 'custom', maxGradient: 9 } });
  settings.reset();
  check('reset restores Medium', settings.current.routeSmoothing.preset === 'medium'
    && settings.current.routeSmoothing.maxGradient === PRESETS.medium.maxGradient);
});

report();
