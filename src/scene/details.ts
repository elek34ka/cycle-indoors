import type { RouteGeometry } from './geometry';
import { VERGE_MAX, type Ground } from './ground';
import type { Land, LandKind } from './landscape';
import { distanceToRoute, slicesNear, type Passes } from './passes';
import type { Pond } from './ponds';
import { mulberry, sliceSeed } from './scenery';

/**
 * Ground details: grass tufts, flowers and stones beside the road, and reeds
 * around the ponds. Like the scenery (`scenery.ts`) they are placed from a
 * seed per slice, so a slice places the same details whichever piece asks
 * for it first, and the same route always gets the same ones.
 *
 * They are small and many, so the renderer draws them only near the rider;
 * where they stand is decided here, the same for every season.
 */

export const DETAIL_KINDS = ['grass', 'flower', 'stone', 'reed'] as const;
export type DetailKind = (typeof DETAIL_KINDS)[number];

export interface DetailItem {
  kind: DetailKind;
  x: number;
  z: number;
  /** the drawn surface under it, unexaggerated: ground, verge, or a pond's shallow bottom for a reed */
  y: number;
  scale: number;
  /** rotation about the vertical, radians */
  turn: number;
  /** the slice that placed it */
  slice: number;
  /** a seeded shade in [0, 1) */
  tint: number;
}

/** No detail stands closer to any pass's centre line than this: the road and its shoulder. */
export const DETAIL_CLEARANCE = 4.5;
/** details are placed out to this far from the road */
export const DETAIL_REACH = 60;
/** reeds grow along a pond's visible shoreline, from this far into the water… */
export const REED_INSIDE = 4;
/** …to this far up the shore */
export const REED_OUTSIDE = 2;
/** and never in water deeper than this, metres */
export const REED_DEPTH = 0.5;
/** one reed candidate per this many square metres of the ring */
const REED_AREA = 3;
/** a pond's reeds are placed by the slice nearest its road point, found within this */
const OWNER_REACH = 30;

interface Mix { count: number; kinds: [DetailKind, number][] }

/** detail candidates per slice and side, and their kinds, for each kind of land */
const MIX: Record<LandKind, Mix> = {
  meadow: { count: 13, kinds: [['grass', 0.6], ['flower', 0.35], ['stone', 0.05]] },
  fields: { count: 11, kinds: [['grass', 0.7], ['flower', 0.2], ['stone', 0.1]] },
  farmland: { count: 8, kinds: [['grass', 0.8], ['flower', 0.1], ['stone', 0.1]] },
  heath: { count: 7, kinds: [['grass', 0.55], ['flower', 0.25], ['stone', 0.2]] },
  mixed: { count: 5, kinds: [['grass', 0.6], ['flower', 0.15], ['stone', 0.25]] },
  upland: { count: 5, kinds: [['grass', 0.45], ['flower', 0.05], ['stone', 0.5]] },
  broadleaf: { count: 4, kinds: [['grass', 0.55], ['flower', 0.2], ['stone', 0.25]] },
  conifer: { count: 2.5, kinds: [['grass', 0.4], ['flower', 0.05], ['stone', 0.55]] },
};

const SCALE: Record<DetailKind, [number, number]> = {
  grass: [0.6, 1.2],
  flower: [0.7, 1.1],
  stone: [0.5, 1.4],
  reed: [0.8, 1.3],
};

function pick(kinds: [DetailKind, number][], r: number): DetailKind {
  let acc = 0;
  for (const [k, w] of kinds) { acc += w; if (r < acc) return k; }
  return kinds[kinds.length - 1][0];
}

/**
 * The drawn surface at (x, z), or undefined within DETAIL_CLEARANCE of a
 * pass. One search serves both: with no road within the verge's reach,
 * `surfaceAt` finds nothing to add to the lattice and is `drawnHeightAt`
 * exactly, so the road and verge triangles are only read near a road.
 */
function footing(p: Passes, ground: Ground, x: number, z: number): number | undefined {
  const d = distanceToRoute(p, x, z, VERGE_MAX + 1);
  if (d < DETAIL_CLEARANCE) return undefined;
  return d === Infinity ? ground.drawnHeightAt(x, z) : ground.surfaceAt(x, z);
}

const inWater = (ponds: Pond[], x: number, z: number) => ponds.some((q) => Math.hypot(x - q.cx, z - q.cz) < q.R);

/**
 * The slice that places a pond's reeds: the drawn slice nearest the road
 * point the pond is set beside, the lower index on a tie. Repeated slices
 * place nothing, so they never own one.
 */
export function reedOwner(p: Passes, pond: Pond): number {
  let best = -1;
  let bestD = Infinity;
  for (const k of slicesNear(p, pond.ax, pond.az, OWNER_REACH)) {
    if (p.repeat[k]) continue;
    const d = Math.hypot(p.px[k] - pond.ax, p.pz[k] - pond.az);
    if (d < bestD || (d === bestD && k < best)) { best = k; bestD = d; }
  }
  return best;
}

/** the shoreline is found along this many directions from a pond's centre */
export const SHORE_SECTORS = 64;
const SHORE_STEP = 0.25;

/**
 * Where the water shows: along each of SHORE_SECTORS directions from the
 * pond's centre, the farthest distance (in SHORE_STEP steps, within R) at
 * which the drawn surface is below the level; 0 where it never is. The water
 * disc R only covers the pond, and the drawn ground hides most of its rim, so
 * the shoreline is usually well inside R.
 */
export function shoreline(ground: Ground, pond: Pond): number[] {
  const out: number[] = [];
  for (let s = 0; s < SHORE_SECTORS; s++) {
    const a = (s / SHORE_SECTORS) * Math.PI * 2;
    let edge = 0;
    for (let d = Math.floor(pond.R / SHORE_STEP) * SHORE_STEP; d > 0; d -= SHORE_STEP) {
      if (ground.surfaceAt(pond.cx + Math.cos(a) * d, pond.cz + Math.sin(a) * d) < pond.level) { edge = d; break; }
    }
    out.push(edge);
  }
  return out;
}

function pondSeed(seed: number, pond: Pond): number {
  return sliceSeed(seed ^ 0x5bd1e995, Math.round(pond.cx) * 73856093 ^ Math.round(pond.cz) * 19349663);
}

/** Every detail slice `i` places: its own on both sides, and the reeds of any pond it owns. */
export function placeDetailSlice(g: RouteGeometry, p: Passes, ground: Ground, land: Land, seed: number, i: number): DetailItem[] {
  if (p.repeat[i] || i + 1 >= g.count) return [];
  const rand = mulberry(sliceSeed(seed ^ 0x27d4eb2f, i));
  const out: DetailItem[] = [];
  const step = g.distance[i + 1] - g.distance[i];
  const mix = MIX[land.kind[i]];
  const reach = DETAIL_REACH + step + 1;
  // every pond within reach of the slice, for the water test and for reeds
  const ponds = ground.ponds(p.px[i] - reach - 100, p.pz[i] - reach - 100, p.px[i] + reach + 100, p.pz[i] + reach + 100);

  for (const side of [-1, 1]) {
    const width = Math.min(DETAIL_REACH, side < 0 ? p.left[i] : p.right[i]);
    const n = Math.floor(mix.count) + (rand() < mix.count % 1 ? 1 : 0);
    for (let c = 0; c < n; c++) {
      const kind = pick(mix.kinds, rand());
      // denser near the road, thinning out with distance
      const u = rand();
      const lateral = DETAIL_CLEARANCE + u ** 1.5 * Math.max(0, width - DETAIL_CLEARANCE);
      const along = rand() * step;
      const [s0, s1] = SCALE[kind];
      const scale = s0 + rand() * (s1 - s0);
      const turn = rand() * Math.PI * 2;
      const tint = rand();
      if (width <= DETAIL_CLEARANCE) continue;
      const x = p.px[i] + g.tx[i] * along + g.rx[i] * lateral * side;
      const z = p.pz[i] + g.tz[i] * along + g.rz[i] * lateral * side;
      if (inWater(ponds, x, z)) continue;
      const y = footing(p, ground, x, z);
      if (y === undefined) continue;
      out.push({ kind, x, z, y, scale, turn, slice: i, tint });
    }
  }

  // reeds: the whole ring of every pond this slice owns, seeded by the pond itself
  const owned = ponds.filter((q) => Math.hypot(q.ax - p.px[i], q.az - p.pz[i]) <= OWNER_REACH).filter((q) => reedOwner(p, q) === i);
  for (const pond of owned) {
    const r = mulberry(pondSeed(seed, pond));
    const edge = shoreline(ground, pond);
    // about one candidate per REED_AREA of a ring REED_INSIDE + REED_OUTSIDE wide along the mean shoreline
    const mean = edge.reduce((s, e) => s + e, 0) / edge.length;
    const n = Math.round((2 * Math.PI * mean * (REED_INSIDE + REED_OUTSIDE)) / REED_AREA);
    for (let c = 0; c < n; c++) {
      const a = r() * Math.PI * 2;
      const across = r() * (REED_INSIDE + REED_OUTSIDE) - REED_INSIDE;
      const [s0, s1] = SCALE.reed;
      const scale = s0 + r() * (s1 - s0);
      const turn = r() * Math.PI * 2;
      const tint = r();
      // the shoreline in this direction, between the two sectors either side
      const f = (a / (Math.PI * 2)) * SHORE_SECTORS;
      const s = Math.floor(f) % SHORE_SECTORS;
      const e0 = edge[s];
      const e1 = edge[(s + 1) % SHORE_SECTORS];
      if (e0 === 0 || e1 === 0) continue;
      const d = e0 + (e1 - e0) * (f - Math.floor(f)) + across;
      if (d <= 0) continue;
      const x = pond.cx + Math.cos(a) * d;
      const z = pond.cz + Math.sin(a) * d;
      const y = footing(p, ground, x, z);
      if (y === undefined) continue;
      // on the shore, or in the shallows: never deeper than REED_DEPTH
      const level = ground.waterAt(x, z);
      if (level !== undefined && level - y > REED_DEPTH) continue;
      out.push({ kind: 'reed', x, z, y, scale, turn, slice: i, tint });
    }
  }
  return out;
}

/** Every detail slices [from, to) place. */
export function placeDetails(g: RouteGeometry, p: Passes, ground: Ground, land: Land, seed: number, from: number, to: number): DetailItem[] {
  const out: DetailItem[] = [];
  for (let i = Math.max(0, from); i < Math.min(g.count, to); i++) {
    for (const item of placeDetailSlice(g, p, ground, land, seed, i)) out.push(item);
  }
  return out;
}
