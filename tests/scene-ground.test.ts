import { setupDom } from './dom-setup';
setupDom();

const { Course } = await import('../src/activity/course');
const { buildGeometry, routeSeed } = await import('../src/scene/geometry');
const { parseGpx } = await import('../src/activity/gpx');
const { readFileSync } = await import('node:fs');
const { buildViewProfile } = await import('../src/scene/view-profile');
const { buildPasses, forEachSegmentNear, segmentDrawn } = await import('../src/scene/passes');
const { buildGround, CELL, ROAD_EDGE, VERGE_MAX } = await import('../src/scene/ground');
const { check, report, suite } = await import('./harness');
const { coverViolations, floatViolations, meshScene, sliverViolations, flickerViolations, boundaryViolations, rejoinViolations } = await import('./scene-seams');
const { trackFromLocal, outAndBack, hairpin, switchback, eastbound, walk, rng } = await import('./scene-fixtures');
import type { LocalPoint } from './scene-fixtures';
import type { ActivityTrack } from '../src/activity/types';

function scene(points: LocalPoint[] | ActivityTrack) {
  const course = new Course(Array.isArray(points) ? trackFromLocal(points) : points);
  const g = buildGeometry(course);
  const vp = buildViewProfile(course, g);
  const p = buildPasses(g, vp);
  return { g, p, ground: buildGround(p, routeSeed(g), g) };
}

const valley: LocalPoint[] = [];
// a valley road at 100 m with the route's own ridge road 600 m to the north at 300 m
for (let x = 0; x <= 2000; x += 5) valley.push({ x, z: 0, ele: 100 });
for (let z = -5; z >= -600; z -= 5) valley.push({ x: 2000, z, ele: 100 + (-z / 600) * 200 });
for (let x = 1995; x >= 0; x -= 5) valley.push({ x, z: -600, ele: 300 });
const ridge: LocalPoint[] = [];
// a ridge road at 400 m reached by a climb from 100 m
for (let x = 0; x <= 2000; x += 5) ridge.push({ x, z: 0, ele: 100 + x * 0.15 });
for (let x = 2005; x <= 4500; x += 5) ridge.push({ x, z: 0, ele: 400 });

const routes: [string, LocalPoint[] | ActivityTrack, number][] = [
  ['eastbound, rolling', eastbound(3000, (d) => 100 + 20 * Math.sin(d / 300)), 1],
  ['a road crossing the lattice at 30°, climbing 6%', walk(2000, () => Math.PI / 6, (d) => 100 + 0.06 * d), 1],
  ['hairpin, legs 30 m apart', hairpin(600, 30, 0), 1],
  ['U-turn, legs 12 m apart', hairpin(600, 12, 0), 1],
  ['switchback, upper road 40 m beside and 25 m above', switchback(600, 40, 25), 1],
  ['out-and-back climb', outAndBack(1500, 8, 1), 1],
  ['valley road', valley, 1],
  ['ridge road', ridge, 1],
  ['the sample loop', parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'Sample'), 2],
];

for (const [name, pts, along] of routes) {
  suite(`ground: ${name}`, () => {
    const { g, p, ground } = scene(pts);
    const v = coverViolations(g, p, ground, along);
    check(`the drawn ground is below every road across its 4.5 m footprint, sampled every ${along} m along and 0.5 m across`,
      v.over === 0 && v.samples > 0, `${v.over} of ${v.samples}, worst ${v.worst.toFixed(3)} m over`);
    const f = floatViolations(g, p, ground);
    // every verge stops short of every other road's footprint, at its slices and halfway between them
    let reaches = 0;
    let verges = 0;
    let below = 0;
    for (let i = 0; i + 1 < g.count; i++) {
      for (const side of [-1, 1]) {
        const w0 = ground.vergeWidth(i, side);
        const w1 = ground.vergeWidth(i + 1, side);
        if (w0 === 0) continue;
        verges++;
        for (const t of w1 > 0 ? [0, 0.5] : [0]) {
          const w = w0 + (w1 - w0) * t;
          const cx = p.px[i] + (p.px[i + 1] - p.px[i]) * t;
          const cz = p.pz[i] + (p.pz[i + 1] - p.pz[i]) * t;
          const rx = g.rx[i] + (g.rx[i + 1] - g.rx[i]) * t;
          const rz = g.rz[i] + (g.rz[i + 1] - g.rz[i]) * t;
          const rl = Math.hypot(rx, rz) || 1;
          for (let o = ROAD_EDGE + 0.25; o <= w; o += 0.25) {
            const x = cx + (rx / rl) * o * side;
            const z = cz + (rz / rl) * o * side;
            let hit = false;
            forEachSegmentNear(p, x, z, ROAD_EDGE, (h) => { if ((h.k < i - 2 || h.k > i + 2) && segmentDrawn(p, h.k)) hit = true; });
            if (hit) { reaches++; break; }
            if (ground.surfaceAt(x, z) < ground.drawnHeightAt(x, z)) below++;
          }
        }
      }
    }
    check(`no verge reaches another road's footprint (${verges} verge sides, up to ${VERGE_MAX.toFixed(1)} m)`, reaches === 0, `${reaches}`);
    check('the drawn surface is never below the lattice', below === 0, `${below}`);
    check('every verge starts exactly at its road\'s edge', f.detached === 0, `${f.detached}`);
    check('no road floats: just beside every edge the ground is within 0.5 m drawn (at 4×) of it, unless another pass meets it or lies lower nearby',
      f.floating === 0 && f.samples > 0, `${f.floating} of ${f.samples} (${f.excused} beside another pass), worst ${f.worst.toFixed(2)} m at ${f.where}`);

    // the same point always has the same height, even from a fresh build
    const again = scene(pts).ground;
    let differs = 0;
    for (let n = 0; n < 50; n++) {
      const x = p.px[0] - 200 + 31.7 * n;
      const z = p.pz[0] + 37 * Math.sin(n);
      const h = ground.drawnHeightAt(x, z);
      if (h !== ground.drawnHeightAt(x, z) || h !== again.drawnHeightAt(x, z)) differs++;
    }
    check('the same (x, z) gives the same height every time, from any build', differs === 0, `${differs}`);
  });
}

suite('ground: drawn height is the lattice\'s triangles', () => {
  const { ground } = scene(eastbound(2000, (d) => 100 + 30 * Math.sin(d / 200)));
  let off = 0;
  for (let ix = -3; ix < 60; ix += 7) {
    for (let iz = -5; iz <= 5; iz++) {
      if (ground.drawnHeightAt(ix * CELL, iz * CELL) !== ground.latticeHeight(ix, iz)) off++;
    }
  }
  check('at a lattice point it is the lattice height exactly', off === 0, `${off}`);
  // halfway along the v10–v01 diagonal it is their average
  const mid = ground.drawnHeightAt(25 * CELL + CELL / 2, 3 * CELL + CELL / 2);
  const avg = (ground.latticeHeight(26, 3) + ground.latticeHeight(25, 4)) / 2;
  check('on a cell\'s diagonal it is the average of the diagonal\'s ends', Math.abs(mid - avg) < 1e-9, `${mid} vs ${avg}`);
});

suite('ground: the switchback\'s lower road is not buried', () => {
  const { g, p, ground } = scene(switchback(600, 40, 25));
  const mid = Math.round(300 / 10);
  const between = ground.drawnHeightAt(p.px[mid] + g.rx[mid] * 20, p.pz[mid] + g.rz[mid] * 20);
  check('the ground between the legs is below the upper road', between < p.ph[mid] + 25, `${between.toFixed(1)} m`);
});

suite('ground: a valley road keeps its sides', () => {
  const { g, p, ground } = scene(valley);
  const i = Math.round(1000 / 10);
  const side = ground.drawnHeightAt(p.px[i] - g.rx[i] * 250, p.pz[i] - g.rz[i] * 250);
  check('250 m toward the ridge the land is well above the valley road', side > p.ph[i] + 20, `${side.toFixed(1)} vs road ${p.ph[i].toFixed(1)}`);
});


suite('ground: ponds keep every road rule', () => {
  // the first of a few winding 12 km meadow roads that holds at least two ponds
  let on: ReturnType<typeof meshScene> | undefined;
  let pts: LocalPoint[] = [];
  let count = 0;
  for (let seed = 1; seed <= 12 && count < 2; seed++) {
    const r = rng(seed);
    const a = r() * 6, w = 900 + r() * 1200;
    pts = walk(12000, (d) => a + 0.7 * Math.sin(d / w), (d) => 100 + 6 * Math.sin(d / 700));
    on = meshScene(pts, { ponds: true, kind: 'meadow' });
    count = on.ground.ponds(Math.min(...on.p.px) - 500, Math.min(...on.p.pz) - 500, Math.max(...on.p.px) + 500, Math.max(...on.p.pz) + 500).length;
  }
  check(`a winding meadow road with ponds (${count})`, count >= 2);
  if (!on) return;
  const off = meshScene(pts, { kind: 'meadow' });
  const measure = (s: NonNullable<typeof on>) => {
    const f = floatViolations(s.g, s.p, s.ground);
    const sl = sliverViolations(s);
    const b = boundaryViolations(s);
    const r = rejoinViolations(s);
    return {
      cover: coverViolations(s.g, s.p, s.ground).over,
      floating: f.floating,
      detached: f.detached,
      slivers: sl.missing,
      flicker: flickerViolations(s).shared,
      boundaries: b.differ + b.unfound,
      rejoins: r.off,
    };
  };
  const a = measure(on);
  const b = measure(off);
  check(`every seam measure is zero with ponds (${JSON.stringify(a)})`, Object.values(a).every((n) => n === 0));
  check('and without them', Object.values(b).every((n) => n === 0), JSON.stringify(b));
  // beside a pond the verge is cut back, so the pond can come near: the fixture must exercise that
  let cut = 0;
  let changed = 0;
  for (let i = 0; i < on.p.count; i++) for (const side of [-1, 1]) {
    const w = on.ground.vergeWidth(i, side);
    const was = off.ground.vergeWidth(i, side);
    if (w === 0 && was > 0) cut++;
    else if (w !== was) changed++;
  }
  check(`verges are cut back beside the ponds (${cut} slice sides), and no other verge changes`, cut > 0 && changed === 0, `${changed} changed`);
});

report();
