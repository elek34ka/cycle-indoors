import type { RouteGeometry } from './geometry';
import type { Passes } from './passes';

/**
 * The kind of land beside each 10 m slice of the route. It is invented, never
 * real land cover: chosen from the drawn profile (how high above the route's
 * lowest point, how steep over ±150 m) plus a variation seeded by the route
 * and slow along it, so a long flat route still passes through several
 * kinds. Every stretch of one kind lasts at least MIN_RUN metres, and
 * colours blend over ±BLEND_SLICES slices (`weights`).
 */

export const LAND_KINDS = ['fields', 'meadow', 'farmland', 'mixed', 'broadleaf', 'conifer', 'heath', 'upland'] as const;
export type LandKind = (typeof LAND_KINDS)[number];

/** shortest stretch of one kind, metres along the route */
export const MIN_RUN = 300;
/** the variation's wavelength along the route, metres */
const WAVELENGTH = 2500;
/** colours blend over this many slices either side (±50 m) */
export const BLEND_SLICES = 5;

export interface Land {
  /** the kind of land at each slice */
  kind: LandKind[];
  /** each kind's share at slice i, in LAND_KINDS order, summing to 1; for colours only (a repeated slice has its root's) */
  weights(i: number): Float32Array;
}

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function hash1(seed: number, k: number): number {
  let h = Math.imul(seed ^ Math.imul(k, 0x9e3779b1), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1;
}

/** Smooth 1D value noise in [−1, 1]. */
export function noise1(seed: number, x: number, wavelength: number): number {
  const f = x / wavelength;
  const k = Math.floor(f);
  const t = smoothstep(f - k);
  return hash1(seed, k) * (1 - t) + hash1(seed, k + 1) * t;
}

/**
 * The kind a slice would have on its own:
 * - **high** ground (top quarter of a route rising more than 150 m) is heath or upland;
 * - **steep** ground (more than about 3.5% over ±150 m) is mixed woods, broadleaf or conifer forest;
 * - anything else is fields, meadow, farmland or, now and then, mixed woods.
 *
 * Within each group the seeded variations choose.
 */
export function rawKind(rel: number, range: number, slope: number, a: number, b: number): LandKind {
  const high = range > 150 ? smoothstep((rel - 0.6) / 0.2) : 0;
  const steep = smoothstep((slope - 0.02) / 0.03);
  if (high > 0.5) return a < 0 ? 'heath' : 'upland';
  if (steep > 0.5) return a < -0.25 ? 'conifer' : a < 0.25 ? 'mixed' : 'broadleaf';
  if (b > 0.45) return 'mixed';
  return a < -0.2 ? 'fields' : a < 0.2 ? 'meadow' : 'farmland';
}

export function buildLand(g: RouteGeometry, p: Passes, seed: number): Land {
  const n = g.count;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) { lo = Math.min(lo, p.ph[i]); hi = Math.max(hi, p.ph[i]); }
  const range = Math.max(1, hi - lo);
  const kind: LandKind[] = new Array(n);
  const anchored = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    // slope over ±150 m, so a single ramp does not flip the land
    const a = Math.max(0, i - 15);
    const b = Math.min(n - 1, i + 15);
    const run = Math.max(1, g.distance[b] - g.distance[a]);
    const slope = Math.abs(p.ph[b] - p.ph[a]) / run;
    kind[i] = rawKind((p.ph[i] - lo) / range, range, slope, noise1(seed, g.distance[i], WAVELENGTH), noise1(seed ^ 0x5bd1e995, g.distance[i], WAVELENGTH * 0.7));
  }
  mergeShortRuns(g, kind, anchored);
  // a repeated slice rides an earlier pass's road, which already has its land
  for (let i = 0; i < n; i++) {
    if (p.repeat[i] && p.root[i] !== i) { kind[i] = kind[p.root[i]]; anchored[i] = 1; }
  }
  mergeShortRuns(g, kind, anchored);

  // colour weights: a raised-cosine window of ±BLEND_SLICES slices along the route
  const K = LAND_KINDS.length;
  const index = new Map<LandKind, number>(LAND_KINDS.map((k, j) => [k, j]));
  const kernel: number[] = [];
  for (let o = -BLEND_SLICES; o <= BLEND_SLICES; o++) kernel.push(Math.cos((o / (BLEND_SLICES + 1)) * (Math.PI / 2)) ** 2);
  const table = new Float32Array(n * K);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let o = -BLEND_SLICES; o <= BLEND_SLICES; o++) {
      const j = Math.max(0, Math.min(n - 1, i + o));
      const w = kernel[o + BLEND_SLICES];
      table[i * K + index.get(kind[j])!] += w;
      sum += w;
    }
    for (let k = 0; k < K; k++) table[i * K + k] /= sum;
  }
  // a repeated slice is drawn by its root's road, so it shares the root's colour too
  for (let i = 0; i < n; i++) {
    const r = p.root[i];
    if (p.repeat[i] && r !== i) table.copyWithin(i * K, r * K, (r + 1) * K);
  }
  return { kind, weights: (i) => table.subarray(i * K, (i + 1) * K) };
}

/** Runs of one kind as [from, to) slice ranges. */
export function landRuns(kind: readonly LandKind[]): [number, number][] {
  const runs: [number, number][] = [];
  let from = 0;
  for (let i = 1; i <= kind.length; i++) {
    if (i === kind.length || kind[i] !== kind[from]) { runs.push([from, i]); from = i; }
  }
  return runs;
}

/**
 * Repeatedly gives the shortest run under MIN_RUN the kind of its longer
 * neighbour, until none is left. A run holding an anchored slice (one that
 * takes an earlier pass's land) is never changed.
 */
function mergeShortRuns(g: RouteGeometry, kind: LandKind[], anchored: Uint8Array): void {
  const length = ([a, b]: [number, number]) => g.distance[Math.min(b, g.count - 1)] - g.distance[a];
  const fixed = ([a, b]: [number, number]) => { for (let i = a; i < b; i++) if (anchored[i]) return true; return false; };
  for (;;) {
    const runs = landRuns(kind);
    if (runs.length < 2) return;
    let shortest = -1;
    for (let r = 0; r < runs.length; r++) {
      if (length(runs[r]) >= MIN_RUN || fixed(runs[r])) continue;
      if (shortest < 0 || length(runs[r]) < length(runs[shortest])) shortest = r;
    }
    if (shortest < 0) return;
    const before = runs[shortest - 1];
    const after = runs[shortest + 1];
    const into = !before ? after : !after ? before : length(before) >= length(after) ? before : after;
    const [a, b] = runs[shortest];
    for (let i = a; i < b; i++) kind[i] = kind[into[0]];
  }
}
