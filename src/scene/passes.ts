import { seriesAt, type RouteGeometry } from './geometry';
import type { ViewProfile } from './view-profile';

/**
 * Where the route meets itself. A road ridden more than once is drawn once,
 * by its first pass, and every later pass rides on that road; the roadside
 * strip of each drawn slice stops halfway to any other road beside it.
 */

/** Half the drawn road's width, metres. */
export const ROAD_HALF_WIDTH = 3.5;
/** How far the roadside strip reaches from the centre line at most. */
export const RIBBON_MAX = 150;

const CELL = 50;
/** a later pass this close and this near in height rides the earlier road */
const REPEAT_DISTANCE = 12;
const REPEAT_HEIGHT = 4;
/** slices apart a repeat must be, and near a U-turn */
const REPEAT_GAP = 40;
const REPEAT_GAP_UTURN = 6;
/** passes must run within about 30° of parallel (either way) to repeat */
const REPEAT_ALIGNMENT = 0.85;
/** a heading change over this within ±30 m marks a U-turn */
const UTURN_ANGLE = (140 * Math.PI) / 180;
const UTURN_HALF_SPAN = 3;
/** slices either side of a U-turn's middle that count as near it */
const UTURN_REACH = 6;
/** another road beside a slice is at least this far sideways per metre along */
const BESIDE_RATIO = 0.7;
/** slices along the route that are never "another road" */
const OWN_NEIGHBOURHOOD = 6;
/** a parallel pass closer than this, at the same height, is the same road */
const SAME_ROAD_DISTANCE = 15;

export interface Passes {
  /** the drawn slice whose road this slice rides on: itself unless it repeats */
  root: Int32Array;
  repeat: Uint8Array;
  /** 1 near a U-turn */
  uturn: Uint8Array;
  /** the drawn centre line the rider follows: the slice's own point, or for a
   *  repeat the nearest point on the earlier pass's road; heights unexaggerated */
  px: Float64Array;
  pz: Float64Array;
  ph: Float64Array;
  /** roadside strip width to the left and right of each drawn slice, metres
   *  from the centre line; 0 on repeats, which are not drawn */
  left: Float64Array;
  right: Float64Array;
  /** slice indices by 50 m cell of their drawn point */
  cells: Map<number, number[]>;
  count: number;
}

const key = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);

function addToCell(cells: Map<number, number[]>, x: number, z: number, i: number): void {
  const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
  const list = cells.get(k);
  if (list) list.push(i); else cells.set(k, [i]);
}

/** Slices whose drawn point lies in a cell within `r` of (x, z), in no particular order. */
export function slicesNear(p: Passes, x: number, z: number, r: number, out: number[] = []): number[] {
  out.length = 0;
  const x0 = Math.floor((x - r) / CELL);
  const x1 = Math.floor((x + r) / CELL);
  const z0 = Math.floor((z - r) / CELL);
  const z1 = Math.floor((z + r) / CELL);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const list = p.cells.get(key(cx, cz));
      if (list) for (const i of list) out.push(i);
    }
  }
  return out;
}

export interface SegmentHit {
  /** segment from slice k to slice k + 1 */
  k: number;
  /** fraction along it of the foot of the perpendicular */
  t: number;
  /** horizontal distance from the query point to the foot */
  d: number;
  /** drawn road height at the foot, unexaggerated */
  h: number;
}

let stamp = 1;
let seen = new Int32Array(0);
const scratch: number[] = [];

/**
 * Calls `visit` for every segment of the drawn centre line within `r` of
 * (x, z), every pass included. Segments are tested exactly, since slices are
 * 10 m apart and a point between two of them can be closer than either.
 * Not re-entrant: `visit` must not search segments itself (it shares the
 * visited marks); collect the hits first and work on them afterwards.
 */
export function forEachSegmentNear(p: Passes, x: number, z: number, r: number, visit: (hit: SegmentHit) => void): void {
  if (seen.length < p.count) seen = new Int32Array(p.count);
  stamp++;
  if (stamp > 2e9) { seen.fill(0); stamp = 1; }
  // a segment is at most ~10 m long, so one whose ends both lie outside
  // r + 10 cannot come within r
  const near = slicesNear(p, x, z, r + 12, scratch);
  for (const i of near) {
    for (const k of [i - 1, i]) {
      if (k < 0 || k + 1 >= p.count || seen[k] === stamp) continue;
      seen[k] = stamp;
      const ax = p.px[k];
      const az = p.pz[k];
      const dx = p.px[k + 1] - ax;
      const dz = p.pz[k + 1] - az;
      const len2 = dx * dx + dz * dz;
      const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
      const fx = ax + dx * t;
      const fz = az + dz * t;
      const d = Math.hypot(x - fx, z - fz);
      if (d <= r) visit({ k, t, d, h: p.ph[k] + (p.ph[k + 1] - p.ph[k]) * t });
    }
  }
}

const roadHits: SegmentHit[] = [];

/**
 * Calls `visit` once for every road within `r` of (x, z): at the road's point
 * nearest (x, z), a local minimum of the distance along the route. A segment
 * merely next to the nearest one is the same road, a little further along,
 * and is skipped; the two legs of a hairpin are two local minima and both
 * count. This is "the road here" for the ground's carve and its tests: the
 * nearby end of the previous segment, clamped, is not the surface over (x, z).
 */
export function forEachRoadNear(p: Passes, x: number, z: number, r: number, visit: (hit: SegmentHit) => void): void {
  roadHits.length = 0;
  forEachSegmentNear(p, x, z, r, (hit) => roadHits.push(hit));
  if (roadHits.length === 0) return;
  roadHits.sort((a, b) => a.k - b.k);
  const hits = roadHits.slice();
  for (let m = 0; m < hits.length; m++) {
    const hit = hits[m];
    const prev = m > 0 && hits[m - 1].k === hit.k - 1 ? hits[m - 1].d : Infinity;
    const next = m + 1 < hits.length && hits[m + 1].k === hit.k + 1 ? hits[m + 1].d : Infinity;
    // a local minimum; of two equal neighbours only the first counts
    if (hit.d < prev && hit.d <= next) visit(hit);
  }
}

/** Distance from (x, z) to the nearest stretch of any pass, or Infinity beyond `r`. */
export function distanceToRoute(p: Passes, x: number, z: number, r: number): number {
  let best = Infinity;
  forEachSegmentNear(p, x, z, r, (hit) => { if (hit.d < best) best = hit.d; });
  return best;
}

export function buildPasses(g: RouteGeometry, vp: ViewProfile): Passes {
  const n = g.count;
  const root = new Int32Array(n);
  const repeat = new Uint8Array(n);
  const uturn = new Uint8Array(n);
  const px = Float64Array.from(g.x);
  const pz = Float64Array.from(g.z);
  const ph = Float64Array.from(vp.heights);
  const p: Passes = { root, repeat, uturn, px, pz, ph, left: new Float64Array(n), right: new Float64Array(n), cells: new Map(), count: n };

  // U-turns: the heading 30 m before and after differ by more than 140°
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - UTURN_HALF_SPAN);
    const b = Math.min(n - 1, i + UTURN_HALF_SPAN);
    const dot = g.tx[a] * g.tx[b] + g.tz[a] * g.tz[b];
    if (Math.acos(Math.max(-1, Math.min(1, dot))) > UTURN_ANGLE) {
      for (let j = Math.max(0, i - UTURN_REACH); j <= Math.min(n - 1, i + UTURN_REACH); j++) uturn[j] = 1;
    }
  }
  const uturnsBefore = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) uturnsBefore[i + 1] = uturnsBefore[i] + uturn[i];

  // Repeats, in route order, so an earlier pass is always settled first.
  const near: number[] = [];
  for (let i = 0; i < n; i++) {
    root[i] = i;
    const x = g.x[i];
    const z = g.z[i];
    let best = -1;
    let bestD = REPEAT_DISTANCE;
    for (const j of slicesNear(p, x, z, REPEAT_DISTANCE, near)) {
      const gap = i - j;
      if (gap <= REPEAT_GAP_UTURN) continue;
      if (gap <= REPEAT_GAP && uturnsBefore[i + 1] - uturnsBefore[j] === 0) continue;
      if (Math.abs(g.tx[i] * g.tx[j] + g.tz[i] * g.tz[j]) < REPEAT_ALIGNMENT) continue;
      if (Math.abs(vp.heights[i] - ph[j]) > REPEAT_HEIGHT) continue;
      const d = Math.hypot(px[j] - x, pz[j] - z);
      if (d <= bestD) { bestD = d; best = j; }
    }
    if (best >= 0) {
      repeat[i] = 1;
      root[i] = root[best];
      // ride on the earlier road: the nearest point of its drawn line around `best`
      let fx = px[best];
      let fz = pz[best];
      let fh = ph[best];
      let fd = Infinity;
      for (const k of [best - 1, best]) {
        if (k < 0 || k + 1 > i - 1) continue;
        const dx = px[k + 1] - px[k];
        const dz = pz[k + 1] - pz[k];
        const len2 = dx * dx + dz * dz;
        const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((x - px[k]) * dx + (z - pz[k]) * dz) / len2)) : 0;
        const cx = px[k] + dx * t;
        const cz = pz[k] + dz * t;
        const d = Math.hypot(x - cx, z - cz);
        if (d < fd) { fd = d; fx = cx; fz = cz; fh = ph[k] + (ph[k + 1] - ph[k]) * t; }
      }
      px[i] = fx;
      pz[i] = fz;
      ph[i] = fh;
    }
    addToCell(p.cells, px[i], pz[i], i);
  }

  // Roadside strips stop halfway to any other road beside them.
  const left = new Float64Array(n);
  const right = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (repeat[i]) continue;
    let l = RIBBON_MAX;
    let r = RIBBON_MAX;
    for (const k of slicesNear(p, px[i], pz[i], 2 * RIBBON_MAX, near)) {
      if (repeat[k] || Math.abs(k - i) <= OWN_NEIGHBOURHOOD) continue;
      const dx = px[k] - px[i];
      const dz = pz[k] - pz[i];
      const d = Math.hypot(dx, dz);
      if (d >= 2 * RIBBON_MAX) continue;
      const along = dx * g.tx[i] + dz * g.tz[i];
      const lateral = dx * g.rx[i] + dz * g.rz[i];
      if (Math.abs(lateral) < BESIDE_RATIO * Math.abs(along)) continue;
      if (d < SAME_ROAD_DISTANCE && Math.abs(ph[k] - ph[i]) <= REPEAT_HEIGHT) continue;
      // halfway to that road itself, not to its nearest slice 10 m along it
      const half = Math.max(ROAD_HALF_WIDTH, segmentDistance(p, k, px[i], pz[i]) / 2);
      if (lateral > 0) r = Math.min(r, half); else l = Math.min(l, half);
    }
    // On the inside of a bend the strip must not reach past the bend's
    // centre, or the strips of neighbouring slices cross and fold over.
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const cross = g.tx[a] * g.tz[b] - g.tz[a] * g.tx[b];
    const dot = g.tx[a] * g.tx[b] + g.tz[a] * g.tz[b];
    const turn = Math.atan2(cross, dot);
    if (Math.abs(turn) > 1e-6) {
      const radius = Math.max(ROAD_HALF_WIDTH, (0.8 * (g.distance[b] - g.distance[a])) / Math.abs(turn));
      // a growing heading turns right (x east, z south)
      if (turn > 0) r = Math.min(r, radius); else l = Math.min(l, radius);
    }
    left[i] = l;
    right[i] = r;
  }
  // min over ±1 drawn slice, so the strip's edge does not saw-tooth
  for (let i = 0; i < n; i++) {
    if (repeat[i]) continue;
    let l = left[i];
    let r = right[i];
    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j >= n || repeat[j]) continue;
      l = Math.min(l, left[j]);
      r = Math.min(r, right[j]);
    }
    p.left[i] = l;
    p.right[i] = r;
  }
  return p;
}

/** Distance from (x, z) to the drawn line on either side of slice k. */
function segmentDistance(p: Passes, k: number, x: number, z: number): number {
  let best = Math.hypot(p.px[k] - x, p.pz[k] - z);
  for (const a of [k - 1, k]) {
    if (a < 0 || a + 1 >= p.count) continue;
    const dx = p.px[a + 1] - p.px[a];
    const dz = p.pz[a + 1] - p.pz[a];
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((x - p.px[a]) * dx + (z - p.pz[a]) * dz) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.px[a] + dx * t - x, p.pz[a] + dz * t - z));
  }
  return best;
}

/** Whether the road between slice k and k + 1 is drawn: not when both ends ride an earlier pass. */
export function segmentDrawn(p: Passes, k: number): boolean {
  return !(p.repeat[k] && p.repeat[k + 1]);
}

export interface DrawnPoint {
  x: number;
  z: number;
  /** unexaggerated */
  h: number;
  /** heading of the drawn line here, radians atan2(z, x) */
  heading: number;
  /** drawn rise over run over ±5 m, unexaggerated */
  slope: number;
}

/** Where the rider is on the drawn road at `distance`: the point, the line's heading and its slope. */
export function drawnAt(g: RouteGeometry, p: Passes, distance: number): DrawnPoint {
  const x = seriesAt(g, p.px, distance);
  const z = seriesAt(g, p.pz, distance);
  const h = seriesAt(g, p.ph, distance);
  let heading = 0;
  for (const span of [6, 12, 24]) {
    const ax = seriesAt(g, p.px, distance - span);
    const az = seriesAt(g, p.pz, distance - span);
    const bx = seriesAt(g, p.px, distance + span);
    const bz = seriesAt(g, p.pz, distance + span);
    if (Math.hypot(bx - ax, bz - az) > 1e-3) { heading = Math.atan2(bz - az, bx - ax); break; }
  }
  const a = Math.max(0, distance - 5);
  const b = Math.min(g.total, distance + 5);
  const slope = b - a > 1e-6 ? (seriesAt(g, p.ph, b) - seriesAt(g, p.ph, a)) / (b - a) : 0;
  return { x, z, h, heading, slope };
}
