import { setupDom } from './dom-setup';
setupDom();

const { Course } = await import('../src/activity/course');
const { parseGpx } = await import('../src/activity/gpx');
const { buildGeometry, routeSeed } = await import('../src/scene/geometry');
const { buildViewProfile } = await import('../src/scene/view-profile');
const { buildPasses } = await import('../src/scene/passes');
const { buildGround } = await import('../src/scene/ground');
const { buildLand } = await import('../src/scene/landscape');
const { placeDetails, placeDetailSlice, reedOwner, DETAIL_KINDS, DETAIL_CLEARANCE, DETAIL_REACH, REED_OUTSIDE, REED_DEPTH } = await import('../src/scene/details');
const { readFileSync } = await import('node:fs');
const { baseError, bruteDistance, drawnTop } = await import('./scene-footing');
const { check, report, suite } = await import('./harness');
const { trackFromLocal, hairpin, switchback, outAndBack, eastbound } = await import('./scene-fixtures');
import type { LocalPoint } from './scene-fixtures';
import type { ActivityTrack } from '../src/activity/types';
import type { LandKind } from '../src/scene/landscape';
import type { DetailItem } from '../src/scene/details';

/** A scene; with `kind`, all its land is that kind and its ground has ponds. */
function build(points: LocalPoint[] | ActivityTrack, kind?: LandKind) {
  const course = new Course(Array.isArray(points) ? trackFromLocal(points) : points);
  const g = buildGeometry(course);
  const p = buildPasses(g, buildViewProfile(course, g));
  const seed = routeSeed(g);
  const land = buildLand(g, p, seed);
  if (kind) land.kind.fill(kind);
  const ground = kind ? buildGround(p, seed, g, land) : buildGround(p, seed, g);
  return { g, p, ground, land, seed, items: placeDetails(g, p, ground, land, seed, 0, g.count) };
}
type Built = ReturnType<typeof build>;

const line = (b: Built) => ({ count: b.p.count, x: b.p.px, z: b.p.pz });
/** details are 60 m out across their slice; on a bend the nearest segment turns away a little */
const BEND = 0.5;
/** the shoreline is sampled along 64 directions in 0.25 m steps: a reed may sit this much farther from water than REED_OUTSIDE */
const SHORE_SLACK = 0.5;

/** the checks every scene keeps: clearance, reach, footing, and the same items however they are asked for */
function common(b: Built) {
  const { g, p, ground, land, seed, items } = b;
  let tooClose = 0;
  let tooFar = 0;
  let nearest = Infinity;
  let farthest = 0;
  for (const it of items) {
    // against every pass's centre line as ridden, by brute force
    const d = bruteDistance(line(b), it.x, it.z);
    nearest = Math.min(nearest, d);
    if (d < DETAIL_CLEARANCE) tooClose++;
    if (it.kind !== 'reed') farthest = Math.max(farthest, d);
    if (it.kind !== 'reed' && d > DETAIL_REACH + BEND) tooFar++;
  }
  check(`no detail within ${DETAIL_CLEARANCE} m of any pass (nearest ${nearest.toFixed(2)} m)`, tooClose === 0, `${tooClose}`);
  check(`no grass, flower or stone beyond ${DETAIL_REACH} m of the road, measured across its slice (up to ${BEND} m more on a bend)`, tooFar === 0, `${tooFar}, farthest ${farthest.toFixed(3)} m`);
  const err = baseError(b, items);
  check('every detail stands on the drawn surface (ground, verge or road), within 1 mm', err <= 1e-3, `off by ${err.toFixed(4)} m`);

  const again = placeDetails(g, p, ground, land, seed, 0, g.count);
  check('placing twice gives identical results', JSON.stringify(again) === JSON.stringify(items));
  const half = Math.floor(g.count / 2);
  const split = [...placeDetails(g, p, ground, land, seed, half, g.count), ...placeDetails(g, p, ground, land, seed, 0, half)];
  split.sort((a, c) => a.slice - c.slice);
  check('placing in two chunks, in either order, gives the same details', JSON.stringify(split) === JSON.stringify(items));
  let fromRepeats = 0;
  for (let i = 0; i < g.count; i++) if (p.repeat[i]) fromRepeats += placeDetailSlice(g, p, ground, land, seed, i).length;
  check('repeated slices place nothing', fromRepeats === 0, `${fromRepeats}`);
}

const routes: [string, LocalPoint[] | ActivityTrack][] = [
  ['hairpin, legs 30 m apart', hairpin(600, 30, 0)],
  ['switchback, 40 m beside and 25 m above', switchback(600, 40, 25)],
  ['out-and-back climb, legs 1 m apart', outAndBack(1500, 8, 1)],
  ['the sample loop', parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'Sample')],
];

for (const [name, pts] of routes) {
  suite(`details: ${name}`, () => {
    const b = build(pts);
    check('places details', b.items.length > 200, `${b.items.length}`);
    common(b);
  });
}

suite('details: ponds get reeds, and nothing else stands in water', () => {
  // a 30 km flat meadow road with its ground's ponds
  const b = build(eastbound(30000, () => 100), 'meadow');
  const { p, ground, items } = b;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < p.count; i++) { x0 = Math.min(x0, p.px[i]); x1 = Math.max(x1, p.px[i]); z0 = Math.min(z0, p.pz[i]); z1 = Math.max(z1, p.pz[i]); }
  const ponds = ground.ponds(x0 - 500, z0 - 500, x1 + 500, z1 + 500);
  check(`the road has ponds (${ponds.length})`, ponds.length >= 2);
  common(b);

  const reeds = items.filter((it) => it.kind === 'reed');
  const others = items.filter((it) => it.kind !== 'reed');
  const wet = others.filter((it) => ground.waterAt(it.x, it.z) !== undefined).length;
  check(`no grass, flower or stone in water (${others.length} of them)`, wet === 0, `${wet}`);
  // whether the drawn surface shows water, read from the arrays (not surfaceAt, which placed them)
  const top = drawnTop(b);
  const pondOf = (x: number, z: number) => ponds.find((q) => Math.hypot(x - q.cx, z - q.cz) < q.R);
  const shows = (x: number, z: number) => { const q = pondOf(x, z); return q !== undefined && top(x, z) < q.level; };
  let deep = 0;
  let worstDepth = 0;
  let shallows = 0;
  let stray = 0;
  let farthest = 0;
  for (const it of reeds) {
    const q = pondOf(it.x, it.z);
    const depth = q ? q.level - it.y : -Infinity;
    if (depth > 0) {
      shallows++;
      worstDepth = Math.max(worstDepth, depth);
      if (depth > REED_DEPTH + 1e-9) deep++;
      continue;
    }
    // on the shore: the water must show within REED_OUTSIDE (plus SHORE_SLACK for the shoreline's sampling)
    let near = Infinity;
    for (let d = 0.25; d <= REED_OUTSIDE + SHORE_SLACK && near === Infinity; d += 0.25) {
      for (let k = 0; k < 48; k++) {
        const a = (k / 48) * Math.PI * 2;
        if (shows(it.x + Math.cos(a) * d, it.z + Math.sin(a) * d)) { near = d; break; }
      }
    }
    if (near === Infinity) stray++;
    else farthest = Math.max(farthest, near);
  }
  check(`no reed in water deeper than ${REED_DEPTH} m (${shallows} of ${reeds.length} in the shallows, deepest ${worstDepth.toFixed(2)} m)`, deep === 0, `${deep}`);
  check(`some reeds stand in the shallows (${shallows}), the rest on the shore`, shallows > reeds.length / 4 && shallows < reeds.length);
  check(`every reed on the shore has water showing within ${REED_OUTSIDE + SHORE_SLACK} m (farthest ${farthest.toFixed(2)} m)`, stray === 0, `${stray} without`);
  const per = ponds.map((q) => reeds.filter((it) => Math.hypot(it.x - q.cx, it.z - q.cz) < q.R + REED_OUTSIDE).length);
  check(`every pond is edged with reeds (${per.join(', ')})`, per.every((n) => n >= 50));
  const owners = ponds.map((q) => reedOwner(p, q));
  check('every pond has one owning slice, a drawn one', owners.every((k) => k >= 0 && !p.repeat[k]), owners.join(', '));
  const keys = reeds.map((it) => `${it.x},${it.z}`);
  check('no reed is placed twice', new Set(keys).size === keys.length, `${keys.length - new Set(keys).size} twice`);
  // without ponds there are no reeds
  const dry = build(eastbound(3000, () => 100));
  check('a ground without ponds grows no reeds', dry.items.every((it) => it.kind !== 'reed'));
});

suite('details: they follow the land', () => {
  const grown = (kind: LandKind) => build(eastbound(4000, () => 100), kind).items.filter((it) => it.kind !== 'reed');
  const meadow = grown('meadow');
  const conifer = grown('conifer');
  check(`meadow is at least twice as dense as conifer forest (${meadow.length} against ${conifer.length} over 4 km)`, meadow.length >= 2 * conifer.length);
  const share = (items: DetailItem[], k: string) => items.filter((it) => it.kind === k).length / items.length;
  check(`meadow has more flowers than conifer forest (${(share(meadow, 'flower') * 100).toFixed(0)}% against ${(share(conifer, 'flower') * 100).toFixed(0)}%)`, share(meadow, 'flower') > share(conifer, 'flower'));
  const seen = new Set<string>(meadow.map((it) => it.kind));
  for (const it of build(eastbound(30000, () => 100), 'meadow').items) seen.add(it.kind);
  const missing = DETAIL_KINDS.filter((k) => !seen.has(k));
  check('every kind of detail is placed somewhere', missing.length === 0, `missing ${missing.join(', ')}`);
  const badTint = meadow.filter((it) => !(it.tint >= 0 && it.tint < 1)).length;
  check('every detail has a tint in [0, 1)', badTint === 0, `${badTint}`);
});

suite('details: a rebuilt route gets the same details', () => {
  const a = build(hairpin(600, 30, 0)).items;
  const b = build(hairpin(600, 30, 0)).items;
  check('every detail is in the same place', JSON.stringify(a) === JSON.stringify(b));
  const c = build(hairpin(600, 32, 0)).items;
  check('a different route gets different details', JSON.stringify(a) !== JSON.stringify(c));
});

report();
