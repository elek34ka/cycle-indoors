import type { RouteGeometry } from './geometry';
import { forEachRoadNear, forEachSegmentNear, ROAD_HALF_WIDTH, segmentDrawn, slicesNear, type Passes } from './passes';
import { pondFinder, R_MAX, shoreReach, type Pond } from './ponds';
import type { Land } from './landscape';

/**
 * Land height around the route, made up locally: no elevation data beyond
 * the route itself is fetched. Every height is unexaggerated metres; the
 * renderer scales them.
 *
 * The ground is drawn as one surface: a world-aligned lattice every CELL
 * metres, two triangles a cell split on the v10–v01 diagonal. A lattice
 * point's height is the lower of two terms:
 * - the made-up land blended toward the nearest road (that road's surface
 *   out to 1 m past its edge plus a cell diagonal, the land from 140 m), so a valley road keeps its sides and a
 *   ridge road its shoulders;
 * - a carve below every road within 150 m: the road minus a margin, flat out
 *   to the road's edge plus one cell diagonal, then rising at 45°. Every
 *   triangle that touches a road's footprint therefore has all three
 *   vertices under that road, and the surface between them cannot rise
 *   through it.
 *
 * Between lattice points the ground is what the triangles make of it:
 * `drawnHeightAt`, never the lattice function between vertices.
 *
 * Beside every road a verge follows it exactly, out to where the lattice may
 * be dug (`VERGE_MAX`), and is drawn over the lattice: its inner edge is the
 * road's edge, so the road never floats however the lattice had to dig on a
 * twisty climb. It stays at the road's height, banking down toward any other,
 * lower road. `surfaceAt` is the topmost drawn surface, verge or lattice,
 * which is what scenery and the camera stand on.
 */

const LATTICE = 240;
const FIELD_RADIUS = 900;
const BLEND_FAR = 140;
const CARVE_RADIUS = 150;
/** tan(45°): steep enough that a switchback 50 m away does not drag the ground under the road above */
const BANK = 1;
/** the ground's lattice spacing, metres */
export const CELL = 10;
/** the drawn road's edge: 3.5 m of asphalt and a 1 m shoulder */
export const ROAD_EDGE = ROAD_HALF_WIDTH + 1;
/** under a road the ground sits this far below it (true metres); polygon offset keeps them apart in depth */
export const GROUND_MARGIN = 0.1;
/** flat under the road out to its edge plus a cell's diagonal: no triangle touching the footprint reaches the bank */
const FLAT = ROAD_EDGE + CELL * Math.SQRT2;
/** the land starts pulling away from a road only beyond this: until then every
 *  triangle within 1 m of the road's edge has all its vertices at the road's
 *  height, so the ground meets the edge even where the land falls away */
const BLEND_NEAR = ROAD_EDGE + 1 + CELL * Math.SQRT2;
/** a verge reaches this far from the centre line: over all of the lattice's flat, possibly dug, zone */
export const VERGE_MAX = FLAT;
/** a verge reads lattice points this near its centre line: its outer edge, its skirt's triangles and a metre */
export const VERGE_READS = VERGE_MAX + CELL * Math.SQRT2 + 1;
/**
 * Lattice points this near a pass are read by the road itself (its
 * footprint, flat zone, edge skirt and the floating check 1 m beyond the
 * edge), so a pond never changes them. Points beyond it a verge may read, so
 * the ground cuts back any verge that could reach a point a pond changes.
 */
export const POND_UNTOUCHABLE = BLEND_NEAR + 0.5;
/** a verge never comes nearer another road's footprint than this */
const VERGE_GAP = 0.5;
/** slices this near along the route are the verge's own road, not another */
const OWN_ROAD = 8;
/** every this many slices feed the coarse land field */
const FIELD_STRIDE = 3;
/** lattice heights kept for `drawnHeightAt`; the cache is emptied when it grows past this */
const CACHE_LIMIT = 200_000;

/**
 * Lateral offsets of a verge's vertices from the centre line. Every slice has
 * all of them, clamped to its own width, so the rings of two neighbouring
 * slices always pair up; a slice without a verge has them all at the road's
 * edge, and the verge tapers to it.
 */
export const VERGE_OFFSETS = [ROAD_EDGE, 7, 10, 14, VERGE_MAX];

/**
 * Horizontal coordinates of everything drawn are rounded to 1/256 m, so any
 * integer origin within ±65 km leaves them exact in float32. The verge rings
 * and road corners here are rounded too, so `surfaceAt` reads the very
 * triangles the meshes draw.
 */
export const quantise = (v: number) => Math.round(v * 256) / 256;

/** One side of a slice's verge: its vertices from the road's edge outwards. */
export interface VergeRing { x: Float64Array; z: Float64Array; h: Float64Array }

/** Height at (x, z) inside triangle a–b–c (xz), or undefined outside it. */
function inTriangle(x: number, z: number, ax: number, az: number, ah: number, bx: number, bz: number, bh: number, cx: number, cz: number, ch: number): number | undefined {
  const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(det) < 1e-12) return undefined;
  const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
  const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
  const l3 = 1 - l1 - l2;
  const e = -1e-9;
  if (l1 < e || l2 < e || l3 < e) return undefined;
  return l1 * ah + l2 * bh + l3 * ch;
}

export interface Ground {
  /** the ground's height at lattice point (ix, iz), that is at (ix·CELL, iz·CELL) */
  latticeHeight(ix: number, iz: number): number;
  /** the drawn ground's height at (x, z): the lattice's triangles, interpolated */
  drawnHeightAt(x: number, z: number): number;
  /** how far slice `i`'s verge reaches on `side` (−1 left, 1 right) from the centre line; 0 for none */
  vergeWidth(i: number, side: number): number;
  /** a verge vertex of slice `i` at (x, z): the road's height, banking down toward any other, lower road */
  vergeHeight(i: number, x: number, z: number): number;
  /** slice `i`'s verge vertices on `side` (−1 left, 1 right), at VERGE_OFFSETS clamped to its width; the first is the road's edge */
  vergeRing(i: number, side: number): VergeRing;
  /** the topmost drawn surface at (x, z): road, verge or lattice, as the meshes draw them */
  surfaceAt(x: number, z: number): number;
  /** the route's lowest drawn height, the base the relief grows from */
  base: number;
  /** every pond whose water reaches into the box (none without the route's land) */
  ponds(x0: number, z0: number, x1: number, z1: number): Pond[];
  /** the water level at (x, z), true metres, or undefined on dry land */
  waterAt(x: number, z: number): number | undefined;
}

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/** Integer hash to [0, 1). */
function hash2(seed: number, ix: number, iz: number): number {
  let h = seed ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [−1, 1] with the given wavelength. */
function valueNoise(seed: number, x: number, z: number, wavelength: number): number {
  const fx = x / wavelength;
  const fz = z / wavelength;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = smoothstep(fx - ix);
  const tz = smoothstep(fz - iz);
  const a = hash2(seed, ix, iz);
  const b = hash2(seed, ix + 1, iz);
  const c = hash2(seed, ix, iz + 1);
  const d = hash2(seed, ix + 1, iz + 1);
  return ((a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz) * 2 - 1;
}

/**
 * The drawn ground of a route. With the route's kinds of land it also holds
 * ponds (`ponds.ts`), lowered into the lattice 30 m or more from every road;
 * without them it has none, which the suite uses to show the ponds change
 * nothing near a road.
 */
export function buildGround(p: Passes, seed: number, g: RouteGeometry, kinds?: Land): Ground {
  let base = Infinity;
  let sum = 0;
  for (let i = 0; i < p.count; i++) { base = Math.min(base, p.ph[i]); sum += p.ph[i]; }
  if (!Number.isFinite(base)) base = 0;
  const mean = p.count > 0 ? sum / p.count : 0;

  // The coarse field: inverse-distance average of route heights within
  // 900 m, on a 240 m lattice, computed when first needed and kept.
  const field = new Map<number, number>();
  const near: number[] = [];
  function fieldNode(ix: number, iz: number): number {
    const k = (ix + 32768) * 65536 + (iz + 32768);
    const cached = field.get(k);
    if (cached !== undefined) return cached;
    const x = ix * LATTICE;
    const z = iz * LATTICE;
    let wsum = 0;
    let hsum = 0;
    let nearestD = Infinity;
    let nearestH = mean;
    for (const i of slicesNear(p, x, z, FIELD_RADIUS, near)) {
      if (i % FIELD_STRIDE !== 0 || p.repeat[i]) continue;
      const d = Math.hypot(p.px[i] - x, p.pz[i] - z);
      if (d > FIELD_RADIUS) continue;
      if (d < nearestD) { nearestD = d; nearestH = p.ph[i]; }
      const w = 1 / (d * d + 400);
      wsum += w;
      hsum += w * p.ph[i];
    }
    const v = wsum > 0 ? hsum / wsum : nearestH;
    field.set(k, v);
    return v;
  }

  function land(x: number, z: number): number {
    const fx = x / LATTICE;
    const fz = z / LATTICE;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = smoothstep(fx - ix);
    const tz = smoothstep(fz - iz);
    const a = fieldNode(ix, iz);
    const b = fieldNode(ix + 1, iz);
    const c = fieldNode(ix, iz + 1);
    const d = fieldNode(ix + 1, iz + 1);
    const coarse = (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
    // relief grows with height above the route's lowest point: lowlands stay
    // gentle, hills get rugged
    const amplitude = 0.25 * Math.max(10, coarse - base);
    const relief = 0.65 * valueNoise(seed, x, z, 420) + 0.35 * valueNoise(seed ^ 0x9e3779b9, x, z, 150);
    return coarse + amplitude * relief;
  }

  /** The made-up land, pulled toward the nearest road's surface near it. */
  function blended(x: number, z: number): number {
    let nearestD = Infinity;
    let nearestH = 0;
    forEachSegmentNear(p, x, z, BLEND_FAR, (hit) => {
      if (hit.d < nearestD) { nearestD = hit.d; nearestH = hit.h; }
    });
    const l = land(x, z);
    if (!Number.isFinite(nearestD)) return l;
    const w = smoothstep((nearestD - BLEND_NEAR) / (BLEND_FAR - BLEND_NEAR));
    return nearestH * (1 - w) + l * w;
  }

  /**
   * Lowest the carve allows at (x, z), below every road:
   * - every segment within the flat zone carves to its own height line,
   *   extended to (x, z) and less the margin. A triangle of the lattice then
   *   has every vertex under the line of any road it touches, so a straight
   *   climb carves nothing below itself, while both legs of a corner count;
   * - beyond the flat zone, each road within 150 m counts once, from its
   *   nearest point, rising on the 45° bank.
   */
  function carve(x: number, z: number): number {
    let lowest = Infinity;
    forEachSegmentNear(p, x, z, FLAT, (hit) => {
      const k = hit.k;
      const dx = p.px[k + 1] - p.px[k];
      const dz = p.pz[k + 1] - p.pz[k];
      const len2 = dx * dx + dz * dz;
      const t = len2 > 1 ? Math.max(-2, Math.min(3, ((x - p.px[k]) * dx + (z - p.pz[k]) * dz) / len2)) : hit.t;
      const c = p.ph[k] + (p.ph[k + 1] - p.ph[k]) * t - GROUND_MARGIN;
      if (c < lowest) lowest = c;
    });
    forEachRoadNear(p, x, z, CARVE_RADIUS, (hit) => {
      if (hit.d <= FLAT) return;
      const c = hit.h - GROUND_MARGIN + BANK * (hit.d - FLAT);
      if (c < lowest) lowest = c;
    });
    return lowest;
  }

  const preCache = new Map<number, number>();
  /** the lattice before ponds: the blended land, carved under every road */
  function preLattice(ix: number, iz: number): number {
    const k = (ix + 1048576) * 2097152 + (iz + 1048576);
    const cached = preCache.get(k);
    if (cached !== undefined) return cached;
    const h = Math.min(blended(ix * CELL, iz * CELL), carve(ix * CELL, iz * CELL));
    if (preCache.size >= CACHE_LIMIT) preCache.clear();
    preCache.set(k, h);
    return h;
  }

  /** a slice's slope over ±60 m, where a pond beside it would lie */
  const slopeAt = (i: number) => {
    const a = Math.max(0, i - 6);
    const b = Math.min(p.count - 1, i + 6);
    return Math.abs(p.ph[b] - p.ph[a]) / Math.max(1, g.distance[b] - g.distance[a]);
  };
  const finder = kinds ? pondFinder({
    seed,
    cell: CELL,
    untouchable: POND_UNTOUCHABLE,
    land: blended,
    lattice: preLattice,
    roadDistance(x, z, r) {
      let nearest = Infinity;
      forEachSegmentNear(p, x, z, r, (hit) => { if (hit.d < nearest) nearest = hit.d; });
      return nearest;
    },
    nearestRoad(x, z, r) {
      let nearest = Infinity;
      let found: { x: number; z: number; dx: number; dz: number } | undefined;
      forEachSegmentNear(p, x, z, r, (hit) => {
        if (hit.d >= nearest) return;
        const k = hit.k;
        const dx = p.px[k + 1] - p.px[k];
        const dz = p.pz[k + 1] - p.pz[k];
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) return;
        nearest = hit.d;
        found = { x: p.px[k] + dx * hit.t, z: p.pz[k] + dz * hit.t, dx: dx / len, dz: dz / len };
      });
      return found;
    },
    landAt(x, z, r) {
      let nearest = Infinity;
      let slice = -1;
      forEachSegmentNear(p, x, z, r, (hit) => { if (hit.d < nearest) { nearest = hit.d; slice = hit.k; } });
      return slice < 0 ? undefined : { kind: kinds.kind[slice], slope: slopeAt(slice) };
    },
  }) : undefined;

  const cache = new Map<number, number>();
  function latticeHeight(ix: number, iz: number): number {
    const k = (ix + 1048576) * 2097152 + (iz + 1048576);
    const cached = cache.get(k);
    if (cached !== undefined) return cached;
    const pre = preLattice(ix, iz);
    const h = finder ? finder.adjusted(ix, iz, pre) : pre;
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(k, h);
    return h;
  }

  /** The verge's carve from other roads near slice `i`: each counted once, more than OWN_ROAD slices away. */
  function otherRoads(i: number, x: number, z: number, own: number): number {
    let h = own;
    forEachRoadNear(p, x, z, CARVE_RADIUS, (hit) => {
      if (Math.abs(hit.k - i) <= OWN_ROAD) return;
      const c = hit.h - GROUND_MARGIN + BANK * Math.max(0, hit.d - ROAD_EDGE);
      if (c < h) h = c;
    });
    return h;
  }

  // Verge widths, worked out when first needed: NaN until then.
  const widths = [new Float64Array(p.count).fill(NaN), new Float64Array(p.count).fill(NaN)];
  /** whether a pond changes lattice points slice i's verge on `side` could read */
  function besidePond(i: number, side: number): boolean {
    if (!finder) return false;
    const pad = VERGE_READS + shoreReach(R_MAX, CELL) + CELL;
    for (const pond of finder.touching(p.px[i] - pad, p.pz[i] - pad, p.px[i] + pad, p.pz[i] + pad)) {
      // nearest the pond's centre comes to the verge's centre line, from slice i − 1 to i + 1
      let d = Infinity;
      for (let k = Math.max(0, i - 1); k < Math.min(p.count - 1, i + 1); k++) {
        const dx = p.px[k + 1] - p.px[k];
        const dz = p.pz[k + 1] - p.pz[k];
        const len2 = dx * dx + dz * dz;
        const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((pond.cx - p.px[k]) * dx + (pond.cz - p.pz[k]) * dz) / len2)) : 0;
        d = Math.min(d, Math.hypot(p.px[k] + dx * t - pond.cx, p.pz[k] + dz * t - pond.cz));
      }
      if (d - shoreReach(pond.r, CELL) >= VERGE_READS) continue;
      const onSide = (pond.cx - p.px[i]) * g.rx[i] + (pond.cz - p.pz[i]) * g.rz[i];
      if (Math.sign(onSide) === Math.sign(side)) return true;
    }
    return false;
  }

  function vergeWidth(i: number, side: number): number {
    if (i < 0 || i >= p.count || p.repeat[i]) return 0;
    const store = widths[side < 0 ? 0 : 1];
    if (!Number.isNaN(store[i])) return store[i];
    // beside a pond the road's edge meets the ground directly, so the pond can come near
    if (besidePond(i, side)) { store[i] = 0; return 0; }
    // the strips' own limit: halfway to another road beside, inside a bend's radius
    let w = Math.min(VERGE_MAX, side < 0 ? p.left[i] : p.right[i]);
    // and short of any road's footprint, the U-turn's other leg included
    for (let o = ROAD_EDGE + VERGE_GAP; o <= w + 1e-9; o += 0.5) {
      const x = p.px[i] + g.rx[i] * o * side;
      const z = p.pz[i] + g.rz[i] * o * side;
      let blocked = false;
      forEachSegmentNear(p, x, z, ROAD_EDGE + VERGE_GAP, (hit) => {
        // a later pass riding this road draws nothing of its own
        if ((hit.k < i - 2 || hit.k > i + 1) && segmentDrawn(p, hit.k)) blocked = true;
      });
      if (blocked) { w = o - VERGE_GAP; break; }
    }
    w = w > ROAD_EDGE + 0.5 ? w : 0;
    store[i] = w;
    return w;
  }

  function drawnHeightAt(x: number, z: number): number {
    const fx = x / CELL;
    const fz = z / CELL;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    // the same split as the tiles: (v00, v10, v01) and (v11, v01, v10)
    if (tx + tz <= 1) {
      const h00 = latticeHeight(ix, iz);
      return h00 + (latticeHeight(ix + 1, iz) - h00) * tx + (latticeHeight(ix, iz + 1) - h00) * tz;
    }
    const h11 = latticeHeight(ix + 1, iz + 1);
    return h11 + (latticeHeight(ix, iz + 1) - h11) * (1 - tx) + (latticeHeight(ix + 1, iz) - h11) * (1 - tz);
  }

  const rings = [new Map<number, VergeRing>(), new Map<number, VergeRing>()];
  function vergeRing(i: number, side: number): VergeRing {
    const store = rings[side < 0 ? 0 : 1];
    const cached = store.get(i);
    if (cached) return cached;
    const width = Math.max(ROAD_EDGE, vergeWidth(i, side));
    const n = VERGE_OFFSETS.length;
    const ring: VergeRing = { x: new Float64Array(n), z: new Float64Array(n), h: new Float64Array(n) };
    VERGE_OFFSETS.forEach((offset, v) => {
      const o = Math.min(offset, width) * side;
      ring.x[v] = quantise(p.px[i] + g.rx[i] * o);
      ring.z[v] = quantise(p.pz[i] + g.rz[i] * o);
      // the first vertex is the road's edge itself, so the verge meets the road exactly
      ring.h[v] = v === 0 ? p.ph[i] : otherRoads(i, ring.x[v], ring.z[v], p.ph[i]);
    });
    if (store.size > CACHE_LIMIT / 10) store.clear();
    store.set(i, ring);
    return ring;
  }

  /** Height of segment k's drawn road and verges at (x, z), as their triangles draw them, or −Infinity. */
  function segmentSurface(k: number, x: number, z: number): number {
    let top = -Infinity;
    const j = k + 1;
    const corner = (i: number, lateral: number): [number, number] => [quantise(p.px[i] + g.rx[i] * lateral), quantise(p.pz[i] + g.rz[i] * lateral)];
    // the road: a–b across slice k, c–d across slice j, triangles a–b–c and b–d–c
    const [ax, az] = corner(k, -ROAD_EDGE);
    const [bx, bz] = corner(k, ROAD_EDGE);
    const [cx, cz] = corner(j, -ROAD_EDGE);
    const [dx, dz] = corner(j, ROAD_EDGE);
    for (const h of [inTriangle(x, z, ax, az, p.ph[k], bx, bz, p.ph[k], cx, cz, p.ph[j]), inTriangle(x, z, bx, bz, p.ph[k], dx, dz, p.ph[j], cx, cz, p.ph[j])]) {
      if (h !== undefined && h > top) top = h;
    }
    for (const side of [-1, 1]) {
      const ri = vergeRing(k, side);
      const rj = vergeRing(j, side);
      for (let v = 0; v + 1 < VERGE_OFFSETS.length; v++) {
        // the same quads the road mesh draws: inner→outer at k, then at j
        const h1 = inTriangle(x, z, ri.x[v], ri.z[v], ri.h[v], ri.x[v + 1], ri.z[v + 1], ri.h[v + 1], rj.x[v], rj.z[v], rj.h[v]);
        const h2 = inTriangle(x, z, ri.x[v + 1], ri.z[v + 1], ri.h[v + 1], rj.x[v + 1], rj.z[v + 1], rj.h[v + 1], rj.x[v], rj.z[v], rj.h[v]);
        for (const h of [h1, h2]) if (h !== undefined && h > top) top = h;
      }
    }
    return top;
  }

  return {
    base,
    latticeHeight,
    drawnHeightAt,
    vergeWidth,
    vergeHeight: (i, x, z) => otherRoads(i, x, z, p.ph[i]),
    vergeRing,
    ponds: (x0, z0, x1, z1) => (finder ? finder.touching(x0, z0, x1, z1) : []),
    waterAt(x, z) {
      if (!finder) return undefined;
      for (const pond of finder.touching(x, z, x, z)) if (Math.hypot(x - pond.cx, z - pond.cz) < pond.R) return pond.level;
      return undefined;
    },
    surfaceAt(x, z) {
      let top = drawnHeightAt(x, z);
      // collected first: working out a verge ring searches segments too, and
      // forEachSegmentNear cannot be nested
      const near: number[] = [];
      forEachSegmentNear(p, x, z, VERGE_MAX + 1, (hit) => { if (segmentDrawn(p, hit.k)) near.push(hit.k); });
      for (const k of near) {
        const h = segmentSurface(k, x, z);
        if (h > top) top = h;
      }
      return top;
    },
  };
}
