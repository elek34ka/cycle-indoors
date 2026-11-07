import type { LandKind } from './landscape';

/**
 * Still ponds beside the road, in hollows of the made-up land. Pure rules:
 * `ground.ts` hands in the land and the roads, and lowers its lattice where
 * these say.
 *
 * The world is cut into POND_CELL squares, and each holds at most one pond,
 * decided the first time anything asks and kept. So nothing is worked out
 * over the whole route up front, and the answer never depends on the order
 * of asking. A cell's seeded candidate is pulled to the nearest road and set
 * beside it, its bowl starting `untouchable` + 0.5 to `untouchable` + 0.5 +
 * POND_SPREAD from the centre line, on whichever side the land is lower.
 *
 * Seen from the saddle the eye is low (1.5 m over a road whose land is drawn
 * up to 4× taller), so a pond is only seen if the bank between it and the road
 * is no higher than its water. So the level comes from the shore nearest the
 * road, and the rest of the shore is brought to a low ring, SHORE_LOW to
 * SHORE_HIGH above the water, moving no point more than MAX_SHIFT. The
 * untouchable shore must be nearly level (within BANK_SPREAD): the water is
 * set by its lowest point, and anywhere higher would be a bank hiding it.
 *
 * Nothing changes a lattice point within `untouchable` of any pass: those are
 * the points the road's own footprint, flat zone and edge read. The ground
 * cuts the verge back wherever a verge could reach a changed point
 * (`ground.ts`), so the road rules cannot notice a pond. The water polygon
 * reaches nearer the road than that, but there it lies under ground that
 * stands above its level, so it never shows.
 *
 * A pond is a bowl of radius `r` lowered below its water `level`, with water
 * drawn as a flat disc out to `R`, one lattice cell's diagonal beyond `r`:
 * - every lattice triangle that can dip below the level has a vertex inside `r`, so lies within `R`;
 * - every lattice point from `r` out to `shoreReach` is above the level (the
 *   untouchable ones set it, the rest are raised to it), so every triangle
 *   reaching from R out to R + SHORE_CHECK is above it, and the water's edge
 *   is always buried in the shore.
 *
 * Two ponds closer than SEPARATION would put one's bowl inside the other's
 * shore, so both are dropped. That decision reads only each neighbour's
 * provisional pond (every rule but this one), so it never depends on order.
 */

export const POND_CELL = 400;
/** the bowl starts at most this much further than the nearest it may (`untouchable` + 0.5) from the road it is set beside */
export const POND_SPREAD = 4;
/** farthest a point of a pond's sight lane is from its centre: the bowl's offset from its road plus the lane's half-width, at most */
export const laneReach = (untouchable: number, cell: number) => Math.hypot(R_MAX + untouchable + 0.5 + POND_SPREAD, LANE_ALONG) + rimRadius(R_MAX, cell) + 1;
/** a pond's sight lane takes in the road this far either way from its road point, where the rider sees it from */
export const LANE_ALONG = 60;
/** the shore is brought to between these heights above the water (true metres) */
export const SHORE_LOW = 0.15;
export const SHORE_HIGH = 0.25;
/** the untouchable shore (the road's side) may vary by at most this, or its lowest point would sink the water below the rest (true metres) */
export const BANK_SPREAD = 1;
/** the most a shore point is moved (true metres); a pond needing more is dropped */
export const MAX_SHIFT = 2;
/** a candidate is only pulled to a road within this of it */
const POND_REACH = 250;
export const R_MIN = 20;
export const R_MAX = 40;
/** the level sits this far below the lowest untouchable shore point (true metres) */
const FREEBOARD = SHORE_LOW;
/** fraction of candidates that become ponds, before the land and road rules */
export const POND_ACCEPT = 0.35;
/** steepest the nearby road may be for a pond (over ±60 m) */
export const MAX_SLOPE = 0.04;
export const UNSUITED: readonly LandKind[] = ['upland'];

export interface Pond {
  cx: number;
  cz: number;
  /** the point of the road it is set beside, and that road's unit direction there */
  ax: number;
  az: number;
  dx: number;
  dz: number;
  /** the bowl's radius: lattice points inside are lowered */
  r: number;
  /** the water disc's radius */
  R: number;
  /** the water's level, true metres */
  level: number;
}

export interface PondDeps {
  seed: number;
  /** the lattice spacing, metres */
  cell: number;
  /** no lattice point within this of any pass is ever changed */
  untouchable: number;
  /** the made-up land at (x, z), before any carve: the walk goes downhill on it */
  land(x: number, z: number): number;
  /** the lattice height before ponds */
  lattice(ix: number, iz: number): number;
  /** distance to the nearest pass's centre line within `r`, or Infinity */
  roadDistance(x: number, z: number, r: number): number;
  /** the nearest point of any pass's centre line within `r`, and that segment's unit direction */
  nearestRoad(x: number, z: number, r: number): { x: number; z: number; dx: number; dz: number } | undefined;
  /** the nearest slice within `r`: its kind of land and its slope over ±60 m */
  landAt(x: number, z: number, r: number): { kind: LandKind; slope: number } | undefined;
}

/** the drawn shore is above the water out to this far past the rim, the polygon's corners included */
export const SHORE_CHECK = 1;
export const rimRadius = (r: number, cell: number) => r + cell * Math.SQRT2 + 0.1;
/** lattice points out to this from the centre set the level: every corner of every triangle within SHORE_CHECK of the rim */
export const shoreReach = (r: number, cell: number) => rimRadius(r, cell) + SHORE_CHECK + cell * Math.SQRT2 + 1;
/** ponds whose centres are closer than this are both dropped: one's bowl would lie in the other's shore */
export const separation = (cell: number) => shoreReach(R_MAX, cell) + cell * Math.SQRT2 + R_MAX + 1;

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A touchable shore point of height h, brought to the low ring around water at `level`. */
export const ringHeight = (level: number, h: number) => Math.max(level + SHORE_LOW, Math.min(level + SHORE_HIGH, h));

/** Bowl depth below the level at fraction `f` (0 centre, 1 edge) of its radius. */
export const bowlDepth = (f: number) => 0.3 + 1.5 * (1 - f * f);

export interface PondFinder {
  /** the pond of cell (cx, cz), or null */
  inCell(cx: number, cz: number): Pond | null;
  /** every pond whose water reaches into the box */
  touching(x0: number, z0: number, x1: number, z1: number): Pond[];
  /** lattice point (ix, iz) of height h, lowered into any bowl it lies in or raised to close any shore */
  adjusted(ix: number, iz: number, h: number): number;
}

export function pondFinder(deps: PondDeps): PondFinder {
  const cells = new Map<string, Pond | null>();
  type Candidate = { x: number; z: number; r: number; ax: number; az: number; dx: number; dz: number };
  const provisional = new Map<string, Candidate | null>();
  const touchable = (x: number, z: number) => deps.roadDistance(x, z, deps.untouchable) >= deps.untouchable;

  /** the cell's pond by every rule but the neighbours' */
  function candidate(cx: number, cz: number): Candidate | null {
    const key = `${cx},${cz}`;
    if (provisional.has(key)) return provisional.get(key)!;
    const found = place(cx, cz);
    provisional.set(key, found);
    return found;
  }

  function place(cx: number, cz: number): Candidate | null {
    const rand = mulberry(Math.imul(deps.seed ^ Math.imul(cx, 0x27d4eb2d) ^ Math.imul(cz, 0x165667b1), 0x85ebca6b) ^ 0x7f4a7c15);
    const x0 = cx * POND_CELL + rand() * POND_CELL;
    const z0 = cz * POND_CELL + rand() * POND_CELL;
    const r = R_MIN + rand() * (R_MAX - R_MIN);
    const clear = r + deps.untouchable + 0.5;
    const offset = clear + rand() * POND_SPREAD;
    if (rand() >= POND_ACCEPT) return null;
    const road = deps.nearestRoad(x0, z0, POND_REACH);
    if (!road) return null;
    // either side of the road at that offset: it must stay in this cell and clear of every other road
    let best: { x: number; z: number; h: number } | null = null;
    for (const side of [-1, 1]) {
      const x = road.x - road.dz * offset * side;
      const z = road.z + road.dx * offset * side;
      if (Math.floor(x / POND_CELL) !== cx || Math.floor(z / POND_CELL) !== cz) continue;
      if (deps.roadDistance(x, z, clear) < clear) continue;
      const h = deps.land(x, z);
      if (!best || h < best.h) best = { x, z, h };
    }
    if (!best) return null;
    const here = deps.landAt(best.x, best.z, POND_REACH);
    if (!here || UNSUITED.includes(here.kind) || here.slope > MAX_SLOPE) return null;
    return { x: best.x, z: best.z, r, ax: road.x, az: road.z, dx: road.dx, dz: road.dz };
  }

  function decide(cx: number, cz: number): Pond | null {
    const own = candidate(cx, cz);
    if (!own) return null;
    const apart = separation(deps.cell);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        if (a === 0 && b === 0) continue;
        const other = candidate(cx + a, cz + b);
        if (other && Math.hypot(other.x - own.x, other.z - own.z) < apart) return null;
      }
    }
    const { x, z, r, ax, az, dx, dz } = own;
    const R = rimRadius(r, deps.cell);
    // the level: below every untouchable lattice point of the shore, the road's side of it
    const reach = shoreReach(r, deps.cell);
    const c = deps.cell;
    const shore: { h: number; fixed: boolean }[] = [];
    for (let ix = Math.floor((x - reach) / c); ix <= Math.ceil((x + reach) / c); ix++) {
      for (let iz = Math.floor((z - reach) / c); iz <= Math.ceil((z + reach) / c); iz++) {
        const d = Math.hypot(ix * c - x, iz * c - z);
        if (d < r || d > reach) continue;
        shore.push({ h: deps.lattice(ix, iz), fixed: !touchable(ix * c, iz * c) });
      }
    }
    const fixed = shore.filter((q) => q.fixed);
    const heights = (fixed.length ? fixed : shore).map((q) => q.h);
    const level = Math.min(...heights) - FREEBOARD;
    if (Math.max(...heights) - Math.min(...heights) > BANK_SPREAD) return null;
    // the rest of the shore is brought to the low ring, each point moved by at most MAX_SHIFT
    for (const q of shore) if (!q.fixed && Math.abs(ringHeight(level, q.h) - q.h) > MAX_SHIFT) return null;
    return { cx: x, cz: z, ax, az, dx, dz, r, R, level };
  }

  function inCell(cx: number, cz: number): Pond | null {
    const key = `${cx},${cz}`;
    if (cells.has(key)) return cells.get(key)!;
    const pond = decide(cx, cz);
    cells.set(key, pond);
    return pond;
  }

  return {
    inCell,
    touching(x0, z0, x1, z1) {
      const out: Pond[] = [];
      // a pond's centre is in its own cell, its water at most R_MAX + a cell diagonal + 0.1 from it
      const pad = rimRadius(R_MAX, deps.cell);
      for (let cx = Math.floor((x0 - pad) / POND_CELL); cx <= Math.floor((x1 + pad) / POND_CELL); cx++) {
        for (let cz = Math.floor((z0 - pad) / POND_CELL); cz <= Math.floor((z1 + pad) / POND_CELL); cz++) {
          const pond = inCell(cx, cz);
          if (!pond) continue;
          const dx = Math.max(x0 - pond.cx, 0, pond.cx - x1);
          const dz = Math.max(z0 - pond.cz, 0, pond.cz - z1);
          if (Math.hypot(dx, dz) <= pond.R) out.push(pond);
        }
      }
      return out;
    },
    adjusted(ix, iz, h) {
      const x = ix * deps.cell;
      const z = iz * deps.cell;
      const cx = Math.floor(x / POND_CELL);
      const cz = Math.floor(z / POND_CELL);
      let out = h;
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          const pond = inCell(cx + a, cz + b);
          if (!pond) continue;
          const d = Math.hypot(x - pond.cx, z - pond.cz);
          if (d < pond.r) out = Math.min(out, pond.level - bowlDepth(d / pond.r));
          else if (d <= shoreReach(pond.r, deps.cell) && touchable(x, z)) out = ringHeight(pond.level, out);
        }
      }
      return out;
    },
  };
}
