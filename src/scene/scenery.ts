import { LANE_ALONG, laneReach, type Pond } from './ponds';
import { CELL, POND_UNTOUCHABLE } from './ground';
import type { RouteGeometry } from './geometry';
import type { Ground } from './ground';
import { distanceToRoute, type Passes } from './passes';
import type { Land, LandKind } from './landscape';

/**
 * Trees, bushes, rocks and roadside posts. Everything is placed from a seed
 * per slice, so a slice grows the same things whichever chunk asks for it
 * first, and the same route always looks the same.
 *
 * What grows depends on the kind of land beside the slice (`landscape.ts`),
 * which is invented and will often be wrong for the real place.
 */

export const SCENERY_KINDS = ['pine', 'spruce', 'broadleaf', 'oak', 'birch', 'poplar', 'dead', 'bush', 'rock', 'post'] as const;
export type SceneryKind = (typeof SCENERY_KINDS)[number];
/** the trees, as opposed to bushes, rocks and posts */
export const TREE_KINDS: readonly SceneryKind[] = ['pine', 'spruce', 'broadleaf', 'oak', 'birch', 'poplar', 'dead'];

export interface SceneryItem {
  kind: SceneryKind;
  x: number;
  z: number;
  /** ground height under it, unexaggerated */
  y: number;
  scale: number;
  /** rotation about the vertical, radians */
  turn: number;
  /** the slice that placed it */
  slice: number;
  /** a seeded shade in [0, 1): how light or dark this one is among its kind */
  tint: number;
}

/** Nothing tall stands closer to any pass's centre line than this. */
export const TREE_CLEARANCE = 6;
export const POST_CLEARANCE = 4;
/** nothing stands within this of a pond's water (its radius R from the centre) */
export const WATER_CLEARANCE = 1;
/** a pond's lane can reach an item this far from its water */
const LANE_REACH = laneReach(POND_UNTOUCHABLE, CELL);

/**
 * Whether (x, z) lies in a pond's sight lane: the hull of its water (plus
 * WATER_CLEARANCE) and the road LANE_ALONG either way from its road point,
 * the ground the rider looks across at it.
 */
export function inLane(pond: Pond, x: number, z: number): boolean {
  const w = pond.R + WATER_CLEARANCE;
  const ends = [-LANE_ALONG, LANE_ALONG].map((a) => [pond.ax + pond.dx * a, pond.az + pond.dz * a]);
  // within w of the segment from the centre to either end, or inside the triangle they make
  for (const [ex, ez] of ends) if (segmentDistance(x, z, pond.cx, pond.cz, ex, ez) < w) return true;
  const [[ax, az], [bx, bz]] = ends;
  const s1 = (bx - ax) * (z - az) - (bz - az) * (x - ax);
  const s2 = (pond.cx - bx) * (z - bz) - (pond.cz - bz) * (x - bx);
  const s3 = (ax - pond.cx) * (z - pond.cz) - (az - pond.cz) * (x - pond.cx);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

function segmentDistance(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
  return Math.hypot(ax + dx * t - x, az + dz * t - z);
}
/** posts stand at this offset, on the right, every this many slices */
const POST_OFFSET = 4.6;
const POST_EVERY = 5;
/** scenery is placed out to this far from the road at most */
const SCENERY_REACH = 120;

const isTall = (k: SceneryKind) => k !== 'post';

/** Seeded random numbers in [0, 1). */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sliceSeed(seed: number, i: number): number {
  return Math.imul(seed ^ Math.imul(i + 1, 0x9e3779b1), 0x85ebca6b) >>> 0;
}

interface Mix { count: number; kinds: [SceneryKind, number][] }

/** what each kind of land grows: candidates per slice and side, and their kinds */
const MIX: Record<LandKind, Mix> = {
  fields: { count: 1.4, kinds: [['oak', 0.25], ['broadleaf', 0.15], ['birch', 0.1], ['bush', 0.4], ['rock', 0.1]] },
  meadow: { count: 1, kinds: [['birch', 0.2], ['oak', 0.15], ['poplar', 0.05], ['bush', 0.5], ['rock', 0.1]] },
  farmland: { count: 0.5, kinds: [['oak', 0.2], ['broadleaf', 0.15], ['bush', 0.6], ['rock', 0.05]] },
  mixed: { count: 4.5, kinds: [['pine', 0.2], ['spruce', 0.15], ['broadleaf', 0.25], ['birch', 0.2], ['oak', 0.1], ['bush', 0.07], ['dead', 0.03]] },
  broadleaf: { count: 6, kinds: [['broadleaf', 0.45], ['oak', 0.3], ['birch', 0.12], ['bush', 0.08], ['dead', 0.05]] },
  conifer: { count: 6, kinds: [['pine', 0.45], ['spruce', 0.4], ['birch', 0.05], ['bush', 0.04], ['dead', 0.03], ['rock', 0.03]] },
  heath: { count: 1.2, kinds: [['bush', 0.5], ['rock', 0.25], ['birch', 0.1], ['pine', 0.1], ['dead', 0.05]] },
  upland: { count: 2.2, kinds: [['rock', 0.5], ['pine', 0.2], ['spruce', 0.15], ['bush', 0.1], ['dead', 0.05]] },
};

/** farmland's poplar rows: a poplar every this many slices, this far from the road */
const ROW_EVERY = 2;
const ROW_NEAR = 8;
const ROW_FAR = 18;

/** First slice of the stretch of one kind of land that slice i is in. */
function runStart(land: Land, i: number): number {
  let a = i;
  while (a > 0 && land.kind[a - 1] === land.kind[i]) a--;
  return a;
}

function pick(kinds: [SceneryKind, number][], r: number): SceneryKind {
  let acc = 0;
  for (const [k, w] of kinds) { acc += w; if (r < acc) return k; }
  return kinds[kinds.length - 1][0];
}

/**
 * Everything slice `i` places, on both sides of its road. Repeated slices
 * place nothing: their road is the earlier pass's, which already has its own.
 */
export function placeSlice(g: RouteGeometry, p: Passes, ground: Ground, land: Land, seed: number, i: number): SceneryItem[] {
  if (p.repeat[i] || i + 1 >= g.count) return [];
  const rand = mulberry(sliceSeed(seed, i));
  const out: SceneryItem[] = [];
  const step = g.distance[i + 1] - g.distance[i];
  const mix = MIX[land.kind[i]];

  const tryPlace = (kind: SceneryKind, along: number, lateral: number, scale: number, turn: number, tint: number) => {
    const x = p.px[i] + g.tx[i] * along + g.rx[i] * lateral;
    const z = p.pz[i] + g.tz[i] * along + g.rz[i] * lateral;
    const clearance = isTall(kind) ? TREE_CLEARANCE : POST_CLEARANCE;
    // every pass counts, measured to its segments, not its slices 10 m apart
    if (distanceToRoute(p, x, z, clearance) < clearance) return;
    // out of the water, and out of the lane between each pond and the road it is set beside, so it can be seen
    for (const pond of ground.ponds(x - LANE_REACH, z - LANE_REACH, x + LANE_REACH, z + LANE_REACH)) {
      if (Math.hypot(x - pond.cx, z - pond.cz) < pond.R + WATER_CLEARANCE) return;
      if (kind !== 'post' && inLane(pond, x, z)) return;
    }
    out.push({ kind, x, z, y: ground.surfaceAt(x, z), scale, turn, slice: i, tint });
  };

  for (const side of [-1, 1]) {
    const width = Math.min(SCENERY_REACH, side < 0 ? p.left[i] : p.right[i]);
    // a whole number of candidates, the fraction by chance
    const n = Math.floor(mix.count) + (rand() < mix.count % 1 ? 1 : 0);
    for (let c = 0; c < n; c++) {
      const kind = pick(mix.kinds, rand());
      // denser near the road, thinning out with distance
      const u = rand();
      const lateral = TREE_CLEARANCE + u * u * Math.max(0, width - TREE_CLEARANCE);
      const along = rand() * step;
      const scale = 0.75 + rand() * 0.6;
      const turn = rand() * Math.PI * 2;
      const tint = rand();
      if (width <= TREE_CLEARANCE) continue;
      tryPlace(kind, along, lateral * side, scale, turn, tint);
    }
  }
  if (land.kind[i] === 'farmland') {
    // a row of poplars along the stretch, at one offset and side for the whole
    // stretch (seeded by where it starts), on the other side if that one has no room
    const start = runStart(land, i);
    if ((i - start) % ROW_EVERY === 0) {
      const row = mulberry(sliceSeed(seed ^ 0x2545f491, start));
      const offset = ROW_NEAR + row() * (ROW_FAR - ROW_NEAR);
      const first = row() < 0.5 ? -1 : 1;
      const room = (side: number) => (side < 0 ? p.left[i] : p.right[i]) > offset + 2;
      const side = room(first) ? first : room(-first) ? -first : 0;
      if (side !== 0) tryPlace('poplar', 0, offset * side, 0.9 + rand() * 0.25, rand() * Math.PI * 2, rand());
    }
  }
  if (i % POST_EVERY === 0) tryPlace('post', 0, POST_OFFSET, 1, 0, rand());
  return out;
}

/** Everything slices [from, to) place. */
export function placeScenery(g: RouteGeometry, p: Passes, ground: Ground, land: Land, seed: number, from: number, to: number): SceneryItem[] {
  const out: SceneryItem[] = [];
  for (let i = Math.max(0, from); i < Math.min(g.count, to); i++) {
    for (const item of placeSlice(g, p, ground, land, seed, i)) out.push(item);
  }
  return out;
}
