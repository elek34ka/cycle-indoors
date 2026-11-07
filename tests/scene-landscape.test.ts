import { setupDom } from './dom-setup';
setupDom();

const { Course } = await import('../src/activity/course');
const { parseGpx } = await import('../src/activity/gpx');
const { readFileSync } = await import('node:fs');
const { buildGeometry, routeSeed } = await import('../src/scene/geometry');
const { buildViewProfile } = await import('../src/scene/view-profile');
const { buildPasses } = await import('../src/scene/passes');
const { buildLand, landRuns, LAND_KINDS, MIN_RUN } = await import('../src/scene/landscape');
const { check, near, report, suite } = await import('./harness');
const { trackFromLocal, outAndBack, hairpin, switchback, eastbound, walk, rng } = await import('./scene-fixtures');
import type { LocalPoint } from './scene-fixtures';
import type { ActivityTrack } from '../src/activity/types';
import type { LandKind } from '../src/scene/landscape';

function land(points: LocalPoint[] | ActivityTrack) {
  const course = new Course(Array.isArray(points) ? trackFromLocal(points) : points);
  const g = buildGeometry(course);
  const p = buildPasses(g, buildViewProfile(course, g));
  return { g, p, land: buildLand(g, p, routeSeed(g)) };
}

/** A gently winding flat route, different for every seed. */
function flatWinding(length: number, seed: number): LocalPoint[] {
  const r = rng(seed);
  const a = r() * 6, b = r() * 6, w1 = 800 + r() * 1500, w2 = 300 + r() * 600;
  return walk(length, (d) => a + 0.6 * Math.sin(d / w1 + b) + 0.2 * Math.sin(d / w2), () => 100);
}

const ridge: LocalPoint[] = [
  ...eastbound(2000, () => 100),
];
// then 2.5 km climbing 12% to 400 m and 3 km along the ridge
for (let x = 2005; x <= 4500; x += 5) ridge.push({ x, z: 0, ele: 100 + (x - 2000) * 0.12 });
for (let x = 4505; x <= 7500; x += 5) ridge.push({ x, z: 0, ele: 400 });

const fixtures: [string, LocalPoint[] | ActivityTrack][] = [
  ['eastbound 20 km, flat', eastbound(20000, () => 100)],
  ['valley to ridge', ridge],
  ['hairpin', hairpin(600, 30, 0)],
  ['switchback', switchback(600, 40, 25)],
  ['out-and-back climb', outAndBack(1500, 8, 1)],
  ['sample loop', parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'Sample')],
];

/** Runs of one kind shorter than MIN_RUN that hold no repeated slice and are not the whole route. */
function shortRuns(s: ReturnType<typeof land>) {
  const runs = landRuns(s.land.kind);
  let short = 0;
  let worst = Infinity;
  if (runs.length < 2) return { short, worst };
  for (const [a, b] of runs) {
    let repeat = false;
    for (let i = a; i < b; i++) if (s.p.repeat[i]) repeat = true;
    if (repeat) continue;
    const length = s.g.distance[Math.min(b, s.g.count - 1)] - s.g.distance[a];
    if (length < MIN_RUN) { short++; worst = Math.min(worst, length); }
  }
  return { short, worst };
}

for (const [name, pts] of fixtures) {
  suite(`landscape: ${name}`, () => {
    const s = land(pts);
    const { short, worst } = shortRuns(s);
    check(`no stretch of one kind is shorter than ${MIN_RUN} m`, short === 0, `${short}, shortest ${worst.toFixed(0)} m`);
    let badSum = 0, worstStep = 0;
    const K = LAND_KINDS.length;
    for (let i = 0; i < s.g.count; i++) {
      const w = s.land.weights(i);
      let sum = 0;
      for (let k = 0; k < K; k++) sum += w[k];
      if (Math.abs(sum - 1) > 1e-5) badSum++;
      if (i > 0 && !s.p.repeat[i] && !s.p.repeat[i - 1]) { const v = s.land.weights(i - 1); for (let k = 0; k < K; k++) worstStep = Math.max(worstStep, Math.abs(w[k] - v[k])); }
    }
    check('colour weights sum to 1 at every slice', badSum === 0, `${badSum}`);
    check(`colour weights move by at most 0.2 per 10 m slice (${worstStep.toFixed(3)})`, worstStep <= 0.2);
    // at every change of kind, the outgoing kind's weight takes at least 50 m to fall from 0.9 to 0.1
    const runs = landRuns(s.land.kind);
    let abrupt = 0;
    for (let r = 1; r < runs.length; r++) {
      // a run of repeated slices takes its root's colours, checked below
      if (s.p.repeat[runs[r][0]] || s.p.repeat[runs[r - 1][1] - 1]) continue;
      const k = LAND_KINDS.indexOf(s.land.kind[runs[r - 1][0]]);
      const at = runs[r][0];
      let from = at, to = at;
      while (from > 0 && s.land.weights(from)[k] < 0.9) from--;
      while (to < s.g.count - 1 && s.land.weights(to)[k] > 0.1) to++;
      if (s.g.distance[to] - s.g.distance[from] < 50) abrupt++;
    }
    check('every change of kind blends over at least 50 m', abrupt === 0, `${abrupt} abrupt`);
    let repeatDiffers = 0;
    for (let i = 0; i < s.g.count; i++) if (s.p.repeat[i] && s.land.kind[i] !== s.land.kind[s.p.root[i]]) repeatDiffers++;
    for (let i = 0; i < s.g.count; i++) if (s.p.repeat[i] && s.land.weights(i).join() !== s.land.weights(s.p.root[i]).join()) repeatDiffers++;
    check('a repeated slice has the land and colours of the road it rides', repeatDiffers === 0, `${repeatDiffers}`);
    const again = land(pts);
    check('the same route gives the same land', again.land.kind.join() === s.land.kind.join());
  });
}

suite('landscape: what the profile chooses', () => {
  const flat = land(eastbound(20000, () => 100));
  const changes = landRuns(flat.land.kind).length - 1;
  check(`a 20 km flat route changes kind at least twice (${changes})`, changes >= 2);
  let fewest = Infinity;
  const seen = new Set<LandKind>();
  for (let seed = 1; seed <= 20; seed++) {
    const s = land(flatWinding(20000, seed));
    fewest = Math.min(fewest, landRuns(s.land.kind).length - 1);
    for (const k of s.land.kind) seen.add(k);
  }
  check(`so do 20 winding flat routes, every one (fewest ${fewest})`, fewest >= 2);
  const r = land(ridge);
  const at = (d: number) => r.land.kind[Math.round(d / 10)];
  const top = [5000, 6000, 7000].map(at);
  check(`the ridge is heath or rocky upland (${top.join(', ')})`, top.every((k) => k === 'heath' || k === 'upland'));
  const climb = [2500, 3000].map(at);
  check(`the climb is woods or forest (${climb.join(', ')})`, climb.every((k) => k === 'mixed' || k === 'broadleaf' || k === 'conifer'));
  for (const k of land(ridge).land.kind) seen.add(k);
  for (let seed = 1; seed <= 12; seed++) {
    const hilly: LocalPoint[] = walk(12000, (d) => seed + Math.sin(d / 900), (d) => 100 + 200 * Math.sin(d / (1500 + 150 * seed)) ** 2);
    for (const k of land(hilly).land.kind) seen.add(k);
  }
  const missing = LAND_KINDS.filter((k) => !seen.has(k));
  check('all eight kinds of land occur across these routes', missing.length === 0, `missing ${missing.join(', ')}`);
  near('weights are the kind itself in the middle of a long stretch', Math.max(...flat.land.weights(Math.round(flat.g.count / 2))), 1, 0.5);
});

report();
