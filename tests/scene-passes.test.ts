import { setupDom } from './dom-setup';
setupDom();

const { Course } = await import('../src/activity/course');
const { parseGpx } = await import('../src/activity/gpx');
const { buildGeometry } = await import('../src/scene/geometry');
const { buildViewProfile } = await import('../src/scene/view-profile');
const { buildPasses, distanceToRoute, segmentDrawn, RIBBON_MAX } = await import('../src/scene/passes');
const { readFileSync } = await import('node:fs');
const { check, near, report, suite } = await import('./harness');
const { trackFromLocal, outAndBack, hairpin, walk } = await import('./scene-fixtures');
import type { LocalPoint } from './scene-fixtures';

function scene(points: LocalPoint[]) {
  const course = new Course(trackFromLocal(points));
  const g = buildGeometry(course);
  const vp = buildViewProfile(course, g);
  return { course, g, vp, p: buildPasses(g, vp) };
}

suite('passes: an out-and-back climb is drawn once', () => {
  const { g, p } = scene(outAndBack(1500, 8, 1));
  const topIndex = (() => { let best = 0; for (let i = 0; i < g.count; i++) if (g.x[i] > g.x[best]) best = i; return best; })();
  let descending = 0;
  let repeated = 0;
  let worstHeight = 0;
  let wrongRoot = 0;
  for (let i = topIndex + 5; i < g.count - 1; i++) {
    descending++;
    if (p.repeat[i]) {
      repeated++;
      const r = p.root[i];
      if (r >= topIndex) wrongRoot++;
      worstHeight = Math.max(worstHeight, Math.abs(p.ph[i] - p.ph[r]));
    }
  }
  check('each of them repeats a slice of the climb', wrongRoot === 0, `${wrongRoot} do not`);
  check('every descending slice from 50 m past the top on repeats the climb', repeated === descending, `${repeated}/${descending}`);
  check('and rides at the climb\'s height, within 0.9 m (10 m slices at 8%)', worstHeight <= 0.9, `${worstHeight.toFixed(2)} m`);

  // the turnaround: nothing drawn twice within 60 m of the top
  let drawnDown = 0;
  for (let i = topIndex + 1; i < g.count - 1; i++) {
    if (Math.hypot(g.x[i] - g.x[topIndex], g.z[i] - g.z[topIndex]) < 60 && segmentDrawn(p, i) && p.repeat[i] === 0 && g.x[i] < g.x[topIndex] - 30) drawnDown++;
  }
  check('the turnaround top is drawn once: no own road on the way down from 30 m below it', drawnDown === 0, `${drawnDown} slices`);
  near('the rider on the way down rides the climb\'s road, not 1 m beside it', p.pz[g.count - 20], 0, 0.01);
});

suite('passes: a route that never nears itself', () => {
  const { g, p } = scene(walk(5000, (d) => Math.sin(d / 900) * 0.9, () => 200));
  let repeats = 0;
  let narrow = 0;
  for (let i = 0; i < g.count; i++) {
    repeats += p.repeat[i];
    if (p.left[i] !== RIBBON_MAX || p.right[i] !== RIBBON_MAX) narrow++;
  }
  check('has no repeats', repeats === 0, `${repeats}`);
  check('and every roadside strip is 150 m wide on both sides', narrow === 0, `${narrow} slices narrower`);
});

suite('passes: a hairpin with legs 30 m apart', () => {
  const { g, p } = scene(hairpin(600, 30, 0));
  let worst = 0;
  let checked = 0;
  for (let i = 0; i < g.count; i++) {
    if (g.x[i] < 50 || g.x[i] > 550) continue; // the legs, away from both ends
    checked++;
    // in a U each leg has the other on its right: south of the eastbound leg,
    // north of the westbound one
    const between = p.right[i];
    worst = Math.max(worst, between);
  }
  check('both legs were checked', checked > 80, `${checked}`);
  check('the strip between the legs is at most 15 m on each', worst <= 15 + 1e-9, `${worst.toFixed(2)} m`);
  let repeats = 0;
  for (let i = 0; i < g.count; i++) repeats += p.repeat[i];
  check('legs 30 m apart are two roads, not a repeat', repeats === 0, `${repeats}`);
  const outside = p.left[Math.round(300 / 10)];
  check('the strip on the outside of the hairpin still reaches 150 m', outside === RIBBON_MAX, `${outside}`);
});

suite('passes: a crossroads at equal height', () => {
  // east 1 km, round a half circle to the south, back west, then north
  // across the first leg at right angles at x = 500
  const pts: LocalPoint[] = [];
  for (let x = 0; x <= 1000; x += 5) pts.push({ x, z: 0, ele: 150 });
  for (let a = 5; a < 180; a += 5) {
    const t = (a * Math.PI) / 180;
    pts.push({ x: 1000 + 250 * Math.sin(t), z: 250 - 250 * Math.cos(t), ele: 150 });
  }
  for (let x = 1000; x >= 500; x -= 5) pts.push({ x, z: 500, ele: 150 });
  for (let z = 495; z >= -300; z -= 5) pts.push({ x: 500, z, ele: 150 });
  const { g, p } = scene(pts);
  let crossingRepeats = 0;
  for (let i = 0; i < g.count; i++) if (Math.abs(g.x[i] - 500) < 1 && Math.abs(g.z[i]) < 20 && p.repeat[i]) crossingRepeats++;
  check('the crossing pass is not marked as a repeat', crossingRepeats === 0, `${crossingRepeats}`);
  check('a point at the crossing is on the route', distanceToRoute(p, 500, 0, 50) < 0.5);
});

suite('passes: strips on the inside of a bend do not fold over', () => {
  // a right-hand 90° bend of radius 20 m
  const { g, p } = scene(walk(400 + (Math.PI / 2) * 20 + 400, (d) => (d < 400 ? 0 : d < 400 + (Math.PI / 2) * 20 ? (d - 400) / 20 : Math.PI / 2), () => 100, 2));
  let folds = 0;
  let worstInside = 0;
  for (let i = 0; i + 1 < g.count; i++) {
    if (p.repeat[i] || p.repeat[i + 1]) continue;
    // the outer edge of the right-hand strip at i and i + 1 must still run forward
    const ax = p.px[i] + g.rx[i] * p.right[i];
    const az = p.pz[i] + g.rz[i] * p.right[i];
    const bx = p.px[i + 1] + g.rx[i + 1] * p.right[i + 1];
    const bz = p.pz[i + 1] + g.rz[i + 1] * p.right[i + 1];
    if ((bx - ax) * g.tx[i] + (bz - az) * g.tz[i] < 0) folds++;
    if (g.distance[i] > 410 && g.distance[i] < 420) worstInside = Math.max(worstInside, p.right[i]);
  }
  check('the inside strip\'s edge never runs backwards', folds === 0, `${folds} slices`);
  check('the inside strip stops short of the bend\'s centre, 20 m in', worstInside < 20, `${worstInside.toFixed(1)} m`);
  check('the outside of the bend keeps its full strip', p.left[Math.round(415 / 10)] === RIBBON_MAX, `${p.left[Math.round(415 / 10)]}`);
});

suite('passes: the sample loop', () => {
  const course = new Course(parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'Sample'));
  const g = buildGeometry(course);
  const p = buildPasses(g, buildViewProfile(course, g));
  // a closed loop's last metres ride onto its own start, which is a real
  // repeat; anything else would mean a false one
  let repeats = 0;
  let finish = 0;
  for (let i = 0; i < g.count; i++) {
    if (!p.repeat[i]) continue;
    if (g.total - g.distance[i] <= 30 && p.root[i] <= 3) finish++; else repeats++;
  }
  check('the sample loop has no repeats', repeats === 0, `${repeats}`);
  check('apart from its finish riding onto its start', finish === 2, `${finish}`);
});

report();
