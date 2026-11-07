import { setupDom } from './dom-setup';
setupDom();

const { Course } = await import('../src/activity/course');
const { parseGpx } = await import('../src/activity/gpx');
const { readFileSync } = await import('node:fs');
const { buildGeometry, routeSeed } = await import('../src/scene/geometry');
const { buildViewProfile } = await import('../src/scene/view-profile');
const { buildPasses } = await import('../src/scene/passes');
const { buildGround, CELL, POND_UNTOUCHABLE } = await import('../src/scene/ground');
const { buildLand } = await import('../src/scene/landscape');
const { POND_SPREAD, SHORE_CHECK, separation, shoreReach } = await import('../src/scene/ponds');
const { EXAGGERATION_DEFAULT } = await import('../src/ui/route-scene-view');
const { EYE_HEIGHT } = await import('../src/scene/camera');
const { check, report, suite } = await import('./harness');
const { trackFromLocal, outAndBack, hairpin, switchback, eastbound, walk, rng } = await import('./scene-fixtures');
import type { LocalPoint } from './scene-fixtures';
import type { ActivityTrack } from '../src/activity/types';
import type { LandKind } from '../src/scene/landscape';
import type { Pond } from '../src/scene/ponds';

function build(points: LocalPoint[] | ActivityTrack, kind?: LandKind) {
  const course = new Course(Array.isArray(points) ? trackFromLocal(points) : points);
  const g = buildGeometry(course);
  const p = buildPasses(g, buildViewProfile(course, g));
  const seed = routeSeed(g);
  const land = buildLand(g, p, seed);
  if (kind) land.kind.fill(kind);
  const ground = buildGround(p, seed, g, land);
  const dry = buildGround(p, seed, g);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < p.count; i++) { x0 = Math.min(x0, p.px[i]); x1 = Math.max(x1, p.px[i]); z0 = Math.min(z0, p.pz[i]); z1 = Math.max(z1, p.pz[i]); }
  const box: [number, number, number, number] = [x0 - 500, z0 - 500, x1 + 500, z1 + 500];
  return { g, p, ground, dry, length: g.distance[g.count - 1] / 1000, box, ponds: ground.ponds(...box) };
}
type Built = ReturnType<typeof build>;

/** Nearest any pass's centre line comes to (x, z), by brute force over every segment. */
function nearestRoad(b: Built, x: number, z: number): number {
  const { p } = b;
  let best = Infinity;
  for (let k = 0; k + 1 < p.count; k++) {
    const dx = p.px[k + 1] - p.px[k];
    const dz = p.pz[k + 1] - p.pz[k];
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((x - p.px[k]) * dx + (z - p.pz[k]) * dz) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.px[k] + dx * t - x, p.pz[k] + dz * t - z));
  }
  return best;
}

/** Every rule a pond's water and shore must keep, measured on the drawn ground. */
function pondViolations(b: Built) {
  const { ground } = b;
  let far = 0, touched = 0, shows = 0, wetRim = 0, lowOutside = 0, dryBowl = 0;
  let nearestWater = Infinity;
  let furthest = 0;
  for (const pond of b.ponds) {
    // the bowl starts beside a road: within the untouchable reach plus the spread
    const bowl = nearestRoad(b, pond.cx, pond.cz) - pond.r;
    furthest = Math.max(furthest, bowl);
    if (bowl > POND_UNTOUCHABLE + 0.5 + POND_SPREAD + 1e-6) far++;
    // no lattice point the road reads is changed, and no water shows there
    const reach = shoreReach(pond.r, CELL) + CELL;
    for (let ix = Math.floor((pond.cx - reach) / CELL); ix <= Math.ceil((pond.cx + reach) / CELL); ix++) {
      for (let iz = Math.floor((pond.cz - reach) / CELL); iz <= Math.ceil((pond.cz + reach) / CELL); iz++) {
        if (nearestRoad(b, ix * CELL, iz * CELL) >= POND_UNTOUCHABLE) continue;
        if (!Object.is(ground.latticeHeight(ix, iz), b.dry.latticeHeight(ix, iz))) touched++;
      }
    }
    for (let x = -pond.R; x <= pond.R; x += 2) {
      for (let z = -pond.R; z <= pond.R; z += 2) {
        if (Math.hypot(x, z) >= pond.R) continue;
        const road = nearestRoad(b, pond.cx + x, pond.cz + z);
        if (ground.surfaceAt(pond.cx + x, pond.cz + z) >= pond.level) continue;
        nearestWater = Math.min(nearestWater, road);
        if (road < SHOWS_FROM) shows++;
      }
    }
    // the rim, every 1 m: buried in the shore
    const steps = Math.ceil(2 * Math.PI * pond.R);
    for (let s = 0; s < steps; s++) {
      const a = (s / steps) * 2 * Math.PI;
      if (ground.drawnHeightAt(pond.cx + pond.R * Math.cos(a), pond.cz + pond.R * Math.sin(a)) < pond.level + 0.1) wetRim++;
    }
    // a 0.5 m grid: above the level from the rim out SHORE_CHECK, below it well inside the bowl
    const out = pond.R + SHORE_CHECK;
    for (let x = -out; x <= out; x += 0.5) {
      for (let z = -out; z <= out; z += 0.5) {
        const d = Math.hypot(x, z);
        const h = ground.drawnHeightAt(pond.cx + x, pond.cz + z);
        if (d > pond.R && d <= out && h <= pond.level) lowOutside++;
        if (d < pond.r - CELL * Math.SQRT2 && h >= pond.level) dryBowl++;
      }
    }
  }
  return { far, touched, shows, wetRim, lowOutside, dryBowl, furthest, nearestWater };
}

/** water can show only in a lattice triangle with a changed corner, so never nearer a pass than this */
const SHOWS_FROM = POND_UNTOUCHABLE - CELL * Math.SQRT2;

/**
 * How much of a pond the rider can see, at most, riding up to it: from an eye
 * EYE_HEIGHT over the drawn road every 20 m for 400 m before its nearest
 * slice, inside the window's ±46° across, the share of its water (sampled
 * every 3 m) whose sight line clears the drawn surface. Trees are not counted:
 * the scenery suite keeps them out of the pond's lane.
 */
function seenShare(b: Built, pond: Pond): number {
  const { g, p, ground } = b;
  const Y = (h: number) => (h - ground.base) * EXAGGERATION_DEFAULT;
  const half = Math.atan(Math.tan(Math.PI / 6) * (16 / 9));
  let at = 0;
  let best = Infinity;
  for (let i = 0; i < p.count; i++) { const d = Math.hypot(p.px[i] - pond.cx, p.pz[i] - pond.cz); if (d < best) { best = d; at = i; } }
  const pts: [number, number][] = [];
  for (let x = -pond.R; x <= pond.R; x += 3) for (let z = -pond.R; z <= pond.R; z += 3) {
    if (ground.drawnHeightAt(pond.cx + x, pond.cz + z) < pond.level) pts.push([pond.cx + x, pond.cz + z]);
  }
  let most = 0;
  for (let i = Math.max(0, at - 40); i <= at; i += 2) {
    const ex = p.px[i], ez = p.pz[i], ey = Y(p.ph[i]) + EYE_HEIGHT;
    const head = Math.atan2(g.tz[i], g.tx[i]);
    let seen = 0;
    for (const [x, z] of pts) {
      const ang = Math.atan2(z - ez, x - ex) - head;
      if (Math.abs(Math.atan2(Math.sin(ang), Math.cos(ang))) > half) continue;
      const d = Math.hypot(x - ex, z - ez);
      let clear = true;
      for (let s = 2; s < d - 0.5 && clear; s += 1) {
        const t = s / d;
        if (Y(ground.surfaceAt(ex + (x - ex) * t, ez + (z - ez) * t)) > ey + (Y(pond.level) - ey) * t + 0.01) clear = false;
      }
      if (clear) seen++;
    }
    most = Math.max(most, seen / Math.max(1, pts.length));
  }
  return most;
}

const winding = (seed: number): LocalPoint[] => {
  const r = rng(seed);
  const a = r() * 6, w = 900 + r() * 1200;
  return walk(30000, (d) => a + 0.7 * Math.sin(d / w), () => 100);
};

suite('ponds: how many', () => {
  const straight = build(eastbound(30000, () => 100), 'meadow');
  const per = straight.length / Math.max(1, straight.ponds.length);
  check(`a 30 km flat meadow road has one pond per 1–2.5 km (${straight.ponds.length}, one per ${per.toFixed(1)} km)`, per >= 1 && per <= 2.5);
  let total = 0, km = 0, none = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const b = build(winding(seed), 'meadow');
    total += b.ponds.length;
    km += b.length;
    if (b.ponds.length === 0) none++;
  }
  const rate = km / Math.max(1, total);
  check(`six winding 30 km meadow roads average one per 1–2.5 km (${total} in ${km.toFixed(0)} km, one per ${rate.toFixed(1)})`, rate >= 1 && rate <= 2.5);
  check(`every one of them has a pond (${none} without)`, none === 0);
  let hidden = 0;
  let least = 1;
  for (const pond of straight.ponds) { const share = seenShare(straight, pond); least = Math.min(least, share); if (share < 0.15) hidden++; }
  check(`riding up to each pond, at least 15% of its water can be seen over the drawn ground (least ${(least * 100).toFixed(0)}%)`, hidden === 0, `${hidden} hidden`);
  const upland = build(eastbound(30000, () => 100), 'upland');
  check(`a rocky upland road has none (${upland.ponds.length})`, upland.ponds.length === 0);
  const forest = build(eastbound(30000, () => 100), 'conifer');
  check(`a conifer forest road has some (${forest.ponds.length})`, forest.ponds.length > 0);
  const steep = build(eastbound(30000, (d) => 100 + 0.1 * d), 'meadow');
  check(`a 10% climb has none (${steep.ponds.length})`, steep.ponds.length === 0);
});

const fixtures: [string, LocalPoint[] | ActivityTrack, LandKind?][] = [
  ['30 km flat meadow', eastbound(30000, () => 100), 'meadow'],
  ['winding meadow, seed 1', winding(1), 'meadow'],
  ['winding meadow, seed 2', winding(2), 'meadow'],
  ['winding fields, seed 3', winding(3), 'fields'],
  ['hairpin', hairpin(600, 30, 0), 'meadow'],
  ['switchback', switchback(600, 40, 25), 'meadow'],
  ['out-and-back', outAndBack(1500, 8, 1), 'meadow'],
  ['sample loop', parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'Sample')],
];

for (const [name, pts, kind] of fixtures) {
  suite(`ponds: ${name}`, () => {
    const b = build(pts, kind);
    const v = pondViolations(b);
    const ponds = b.ponds.length;
    check(`no lattice point within ${POND_UNTOUCHABLE.toFixed(1)} m of any pass is changed (${ponds} ponds)`, v.touched === 0, `${v.touched}`);
    check(`no water shows within ${SHOWS_FROM.toFixed(1)} m of any pass${ponds ? ` (nearest ${v.nearestWater.toFixed(1)} m)` : ''}`, v.shows === 0, `${v.shows}`);
    check(`every bowl starts within ${(POND_UNTOUCHABLE + 0.5 + POND_SPREAD).toFixed(1)} m of a road${ponds ? ` (furthest ${v.furthest.toFixed(1)} m)` : ''}`, v.far === 0, `${v.far}`);
    check('every rim is buried: the drawn ground at least 0.1 m above the water all round', v.wetRim === 0, `${v.wetRim} rim points wet`);
    check(`from the rim out to ${SHORE_CHECK} m beyond it the drawn ground is above the water`, v.lowOutside === 0, `${v.lowOutside}`);
    check('well inside, the bowl is below the water', v.dryBowl === 0, `${v.dryBowl}`);
    const again = build(pts, kind);
    // ask for the ponds in a different order: the far half first, cell by cell
    const [x0, z0, x1, z1] = again.box;
    const mid = (x0 + x1) / 2;
    again.ground.ponds(mid, z0, x1, z1);
    const key = (list: Pond[]) => list.map((q) => `${q.cx.toFixed(6)},${q.cz.toFixed(6)},${q.r.toFixed(6)},${q.level.toFixed(6)}`).sort().join('|');
    check('the same route gives the same ponds, whatever order they are asked for in', key(again.ground.ponds(x0, z0, x1, z1)) === key(b.ponds));
    let close = 0;
    for (let m = 0; m < b.ponds.length; m++) for (let n = m + 1; n < b.ponds.length; n++) {
      if (Math.hypot(b.ponds[m].cx - b.ponds[n].cx, b.ponds[m].cz - b.ponds[n].cz) < separation(CELL)) close++;
    }
    check(`no two ponds are closer than ${separation(CELL).toFixed(0)} m, so no bowl lies in another's shore`, close === 0, `${close}`);
    let wet = 0;
    for (const pond of b.ponds) if (b.ground.waterAt(pond.cx, pond.cz) !== pond.level || b.ground.waterAt(pond.cx + pond.R + 1, pond.cz) !== undefined) wet++;
    check('waterAt is the level inside the water and undefined just outside it', wet === 0, `${wet}`);
  });
}

report();
