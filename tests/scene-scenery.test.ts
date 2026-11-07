import { setupDom } from './dom-setup';
setupDom();

const { Course } = await import('../src/activity/course');
const { parseGpx } = await import('../src/activity/gpx');
const { buildGeometry, routeSeed } = await import('../src/scene/geometry');
const { buildViewProfile } = await import('../src/scene/view-profile');
const { buildPasses } = await import('../src/scene/passes');
const { buildGround } = await import('../src/scene/ground');
const { placeScenery, placeSlice, inLane, TREE_CLEARANCE, POST_CLEARANCE, WATER_CLEARANCE, TREE_KINDS, SCENERY_KINDS } = await import('../src/scene/scenery');
const { buildLand } = await import('../src/scene/landscape');
const { readFileSync } = await import('node:fs');
const { baseError, bruteDistance } = await import('./scene-footing');
const { check, report, suite } = await import('./harness');
const { trackFromLocal, outAndBack, hairpin, switchback, eastbound } = await import('./scene-fixtures');
import type { LocalPoint } from './scene-fixtures';
import type { ActivityTrack } from '../src/activity/types';

function build(points: LocalPoint[] | ActivityTrack) {
  const course = new Course(Array.isArray(points) ? trackFromLocal(points) : points);
  const g = buildGeometry(course);
  const p = buildPasses(g, buildViewProfile(course, g));
  const seed = routeSeed(g);
  const ground = buildGround(p, seed, g);
  const land = buildLand(g, p, seed);
  return { g, p, ground, land, seed, items: placeScenery(g, p, ground, land, seed, 0, g.count) };
}

const routes: [string, LocalPoint[] | ActivityTrack][] = [
  ['hairpin, legs 30 m apart', hairpin(600, 30, 0)],
  ['switchback, 40 m beside and 25 m above', switchback(600, 40, 25)],
  ['out-and-back climb, legs 1 m apart', outAndBack(1500, 8, 1)],
  ['out-and-back climb, legs 10 m apart', outAndBack(1500, 8, 10)],
  ['two passes 10 m apart at different heights', switchback(600, 10, 30)],
  ['the sample loop', parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'Sample')],
];

for (const [name, pts] of routes) {
  suite(`scenery: ${name}`, () => {
    const built = build(pts);
    const { g, p, ground, land, seed, items } = built;
    check('places something', items.length > 20, `${items.length}`);
    let tooClose = 0;
    let postsTooClose = 0;
    let worst = Infinity;
    for (const it of items) {
      // against every pass's centre line as ridden: a repeat rides the earlier
      // pass's road, so its own GPS line beside it is never drawn
      const d = bruteDistance({ count: p.count, x: p.px, z: p.pz }, it.x, it.z);
      if (it.kind === 'post') { if (d < POST_CLEARANCE) postsTooClose++; }
      else { worst = Math.min(worst, d); if (d < TREE_CLEARANCE) tooClose++; }
    }
    check('no tree, bush or rock within 6 m of any pass', tooClose === 0, `${tooClose}, nearest ${worst.toFixed(2)} m`);
    check('no post within 4 m of any pass', postsTooClose === 0, `${postsTooClose}`);
    check('the posts are there', items.some((it) => it.kind === 'post'));
    const err = baseError(built, items);
    check('every item stands on the drawn surface (ground, verge or road), within 1 mm', err <= 1e-3, `off by ${err.toFixed(4)} m`);

    const again = placeScenery(g, p, ground, land, seed, 0, g.count);
    check('placing twice gives identical results', JSON.stringify(again) === JSON.stringify(items));
    // a chunk asking for its own slices gets the same items as the whole route
    const half = Math.floor(g.count / 2);
    const split = [...placeScenery(g, p, ground, land, seed, half, g.count), ...placeScenery(g, p, ground, land, seed, 0, half)];
    split.sort((a, b) => a.slice - b.slice);
    check('placing in two chunks, in either order, gives the same items', JSON.stringify(split) === JSON.stringify(items));

    let fromRepeats = 0;
    for (let i = 0; i < g.count; i++) if (p.repeat[i]) fromRepeats += placeSlice(g, p, ground, land, seed, i).length;
    check('repeated slices place nothing', fromRepeats === 0, `${fromRepeats}`);
  });
}

suite('scenery: keeps out of ponds', () => {
  // a 30 km flat meadow road with its ground's ponds
  const course = new Course(trackFromLocal(eastbound(30000, () => 100)));
  const g = buildGeometry(course);
  const p = buildPasses(g, buildViewProfile(course, g));
  const seed = routeSeed(g);
  const land = buildLand(g, p, seed);
  land.kind.fill('meadow');
  const ground = buildGround(p, seed, g, land);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < p.count; i++) { x0 = Math.min(x0, p.px[i]); x1 = Math.max(x1, p.px[i]); z0 = Math.min(z0, p.pz[i]); z1 = Math.max(z1, p.pz[i]); }
  const ponds = ground.ponds(x0 - 500, z0 - 500, x1 + 500, z1 + 500);
  const items = placeScenery(g, p, ground, land, seed, 0, g.count);
  let wet = 0;
  let closest = Infinity;
  for (const it of items) {
    for (const q of ponds) {
      const d = Math.hypot(it.x - q.cx, it.z - q.cz) - q.R;
      closest = Math.min(closest, d);
      if (d < WATER_CLEARANCE) wet++;
    }
  }
  check(`no tree, bush, rock or post within ${WATER_CLEARANCE} m of a pond's water (${ponds.length} ponds, ${items.length} items, closest ${closest.toFixed(1)} m)`, ponds.length > 0 && wet === 0, `${wet}`);
  let blocking = 0;
  for (const it of items) if (it.kind !== 'post') for (const q of ponds) if (inLane(q, it.x, it.z)) blocking++;
  check(`nothing but posts stands in a pond's sight lane, between it and 60 m of its road either way`, blocking === 0, `${blocking}`);
  // and the lane is real: the same road without ponds grows items there
  const bare = buildGround(p, seed, g);
  const plain = placeScenery(g, p, bare, land, seed, 0, g.count);
  const would = plain.filter((it) => it.kind !== 'post' && ponds.some((q) => inLane(q, it.x, it.z))).length;
  check(`without the ponds, ${would} items would stand in those lanes`, would > 0);
});

suite('scenery: a rebuilt route grows the same scene', () => {
  const a = build(hairpin(600, 30, 0)).items;
  const b = build(hairpin(600, 30, 0)).items;
  check('every item is in the same place', JSON.stringify(a) === JSON.stringify(b));
  const c = build(hairpin(600, 32, 0)).items;
  check('a different route grows a different scene', JSON.stringify(a) !== JSON.stringify(c));
});

suite('scenery: what grows follows the land', () => {
  const flat = build(hairpin(600, 30, 0));
  const open = ['fields', 'meadow', 'farmland', 'mixed'];
  check(`a flat road runs through open land or mixed woods (${[...new Set(flat.land.kind)].join(', ')})`, flat.land.kind.every((k) => open.includes(k)));
  const climb = build(outAndBack(1500, 8, 1));
  const k = climb.land.kind[Math.round(700 / 10)];
  check(`an 8% climb runs through woods or forest (${k})`, k === 'mixed' || k === 'broadleaf' || k === 'conifer');
  // what a 4 km route grows when all of it is one kind of land
  const grown = (kind: string) => {
    const s = build(eastbound(4000, () => 100));
    s.land.kind.fill(kind as never);
    return { s, items: placeScenery(s.g, s.p, s.ground, s.land, s.seed, 0, s.g.count) };
  };
  const trees = (items: { kind: string }[]) => items.filter((it) => (TREE_KINDS as readonly string[]).includes(it.kind));
  const conifer = trees(grown('conifer').items);
  const needles = conifer.filter((it) => it.kind === 'pine' || it.kind === 'spruce').length / conifer.length;
  check(`conifer forest is mostly pine and spruce (${(needles * 100).toFixed(0)}% of its trees)`, needles >= 0.7);
  const farm = grown('farmland');
  const farmTrees = trees(farm.items);
  check(`farmland has at most a third of the forest's trees (${farmTrees.length} against ${conifer.length} over 4 km)`, farmTrees.length * 3 <= conifer.length);
  // a row: poplars all at one distance from the road, one every other slice
  const offsets = new Map<string, number>();
  for (const it of farm.items) {
    if (it.kind !== 'poplar') continue;
    const i = it.slice;
    const lateral = (it.x - farm.s.p.px[i]) * farm.s.g.rx[i] + (it.z - farm.s.p.pz[i]) * farm.s.g.rz[i];
    const key = lateral.toFixed(3);
    offsets.set(key, (offsets.get(key) ?? 0) + 1);
  }
  const longest = Math.max(0, ...offsets.values());
  check(`farmland has a row of poplars (${longest} at one distance from the road)`, longest >= 100);
  const seen = new Set<string>();
  for (const kind of ['fields', 'meadow', 'farmland', 'mixed', 'broadleaf', 'conifer', 'heath', 'upland']) for (const it of grown(kind).items) seen.add(it.kind);
  const missing = SCENERY_KINDS.filter((k) => !seen.has(k));
  check('every kind of tree, bush, rock and post grows somewhere', missing.length === 0, `missing ${missing.join(', ')}`);
  const mixed = grown('mixed').items;
  const badTint = mixed.filter((it) => !(it.tint >= 0 && it.tint < 1)).length;
  let same = 0;
  for (let k = 1; k < mixed.length; k++) if (mixed[k].tint === mixed[k - 1].tint) same++;
  check('every item has a tint in [0, 1), and neighbours differ', badTint === 0 && same === 0, `${badTint} out of range, ${same} equal to the one before`);
});

report();
