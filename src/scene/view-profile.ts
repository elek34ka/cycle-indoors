import type { Course } from '../activity/course';
import { gradients, limitChange, removeSpikes, resample, routeDistances, savitzkyGolay } from '../activity/smoothing';
import { seriesAt, type RouteGeometry } from './geometry';

/**
 * The heights the 3D view draws the road at, built from the route smoother's
 * own steps with settings chosen for looking, not riding: spikes removed, a
 * short smoothing window, drawn gradient within ±20% and changing by at most
 * 2 points per 10 m.
 *
 * The smoother's own change limit runs in one direction and is anchored only
 * at the finish, which leaves a short deep dip drawn far too shallow (18 m out
 * on a real route). Here the heights are instead fitted all at once, as close
 * to the cleaned route as those limits allow (`constrainedFit`).
 *
 * These heights are for drawing only. Readouts, simulated speed and rides
 * keep using `course.at(d)`.
 */
export const VIEW_SMOOTHING = {
  spacing: 10,
  spikeThreshold: 3,
  window: 9,
  /** gradient points per 10 m */
  maxChange: 2,
  maxGradient: 20,
  /** metres between re-anchoring points */
  anchorEvery: 500,
} as const;

export interface ViewProfile {
  /** metres, one per slice, unexaggerated; all zero when the route has no elevation */
  heights: Float64Array;
  hasElevation: boolean;
  min: number;
  max: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** limitChange run forward-then-backward and backward-then-forward, averaged.
 *  Both runs keep every step within ±delta, so their mean does too. */
function limitBothWays(grade: number[], delta: number): number[] {
  const a = limitChange(grade, delta);
  const b = limitChange([...grade].reverse(), delta).reverse();
  return a.map((v, i) => (v + b[i]) / 2);
}

function integrate(start: number, grade: number[], step: number): number[] {
  const out = [start];
  for (const g of grade) out.push(out[out.length - 1] + (g / 100) * step);
  return out;
}

/**
 * Solves the symmetric positive-definite pentadiagonal system that the fit
 * needs, `(I + ρ(D1ᵀD1 + D2ᵀD2)) h = b`, by a banded LDLᵀ factorisation made
 * once and reused every iteration.
 */
function pentadiagonal(n: number, rho: number): (b: Float64Array) => Float64Array {
  // diagonals of D1ᵀD1 + D2ᵀD2, built by adding each row's outer product
  const d0 = new Float64Array(n).fill(1);
  const d1 = new Float64Array(n);
  const d2 = new Float64Array(n);
  for (let i = 0; i + 1 < n; i++) { d0[i] += rho; d0[i + 1] += rho; d1[i] -= rho; }
  for (let i = 0; i + 2 < n; i++) {
    d0[i] += rho; d0[i + 1] += 4 * rho; d0[i + 2] += rho;
    d1[i] -= 2 * rho; d1[i + 1] -= 2 * rho; d2[i] += rho;
  }
  // A = L D Lᵀ with unit lower-triangular L of bandwidth 2
  const D = new Float64Array(n);
  const l1 = new Float64Array(n);
  const l2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a2 = i >= 2 ? d2[i - 2] : 0;
    const a1 = i >= 1 ? d1[i - 1] : 0;
    l2[i] = i >= 2 ? a2 / D[i - 2] : 0;
    l1[i] = i >= 1 ? (a1 - (i >= 2 ? l2[i] * l1[i - 1] * D[i - 2] : 0)) / D[i - 1] : 0;
    D[i] = d0[i] - l1[i] * l1[i] * (i >= 1 ? D[i - 1] : 0) - l2[i] * l2[i] * (i >= 2 ? D[i - 2] : 0);
  }
  return (b) => {
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = b[i] - (i >= 1 ? l1[i] * y[i - 1] : 0) - (i >= 2 ? l2[i] * y[i - 2] : 0);
    for (let i = 0; i < n; i++) y[i] /= D[i];
    for (let i = n - 1; i >= 0; i--) {
      y[i] -= (i + 1 < n ? l1[i + 1] * y[i + 1] : 0) + (i + 2 < n ? l2[i + 2] * y[i + 2] : 0);
    }
    return y;
  };
}

/**
 * The heights closest to `target` (least squares) whose slope stays within
 * ±`b1` metres per step and whose change of slope stays within ±`b2`, by ADMM
 * over the first and second differences. Solving for every height at once is
 * what lets a short, deep dip be drawn as deep as the limits allow; limiting
 * the gradient first and correcting afterwards leaves it shallow.
 */
function constrainedFit(target: number[], b1: number, b2: number, iterations = 300): number[] {
  const n = target.length;
  if (n < 3) return [...target];
  const rho = 4;
  const solve = pentadiagonal(n, rho);
  const t = Float64Array.from(target);
  const z1 = new Float64Array(n - 1);
  const u1 = new Float64Array(n - 1);
  const z2 = new Float64Array(n - 2);
  const u2 = new Float64Array(n - 2);
  for (let i = 0; i + 1 < n; i++) z1[i] = clamp(t[i + 1] - t[i], -b1, b1);
  for (let i = 0; i + 2 < n; i++) z2[i] = clamp(t[i] - 2 * t[i + 1] + t[i + 2], -b2, b2);
  let h: Float64Array = t;
  const rhs = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    rhs.set(t);
    // + ρ D1ᵀ(z1 − u1)
    for (let i = 0; i + 1 < n; i++) { const v = rho * (z1[i] - u1[i]); rhs[i] -= v; rhs[i + 1] += v; }
    // + ρ D2ᵀ(z2 − u2)
    for (let i = 0; i + 2 < n; i++) { const v = rho * (z2[i] - u2[i]); rhs[i] += v; rhs[i + 1] -= 2 * v; rhs[i + 2] += v; }
    h = solve(rhs);
    for (let i = 0; i + 1 < n; i++) {
      const d = h[i + 1] - h[i];
      z1[i] = clamp(d + u1[i], -b1, b1);
      u1[i] += d - z1[i];
    }
    for (let i = 0; i + 2 < n; i++) {
      const d = h[i] - 2 * h[i + 1] + h[i + 2];
      z2[i] = clamp(d + u2[i], -b2, b2);
      u2[i] += d - z2[i];
    }
  }
  return Array.from(h);
}

/** Drawn heights on an even grid along the raw track. */
export function viewHeights(points: { lat: number; lon: number; ele?: number }[]): { step: number; distances: number[]; heights: number[] } {
  const located = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const s = VIEW_SMOOTHING;
  const { step, distances, elevations } = resample(routeDistances(located), located.map((p) => p.ele), s.spacing);
  if (elevations.length < 2) return { step, distances, heights: elevations };
  const target = savitzkyGolay(removeSpikes(elevations, step, s.spikeThreshold), s.window);
  const delta = (s.maxChange * step) / 10;
  const fit = constrainedFit(target, (s.maxGradient / 100) * step, (delta / 100) * step);

  // ADMM ends within a hair of the limits, not exactly on them. One exact pass
  // makes the limits hold to the letter, then the result is re-anchored to the
  // fit every `anchorEvery` metres so that pass cannot drift along the route.
  const limit = (g: number[]) => limitBothWays(g.map((v) => clamp(v, -s.maxGradient, s.maxGradient)), delta);
  let grade = limit(gradients(fit, step));
  const every = Math.max(1, Math.round(s.anchorEvery / step));
  const last = fit.length - 1;
  const knots: number[] = [];
  for (let k = 0; k < last; k += every) knots.push(k);
  knots.push(last);
  let built = integrate(fit[0], grade, step);
  for (let round = 0; round < 12; round++) {
    let worst = 0;
    for (const k of knots) worst = Math.max(worst, Math.abs(fit[k] - built[k]));
    if (worst < 0.05) break;
    const next = [...grade];
    for (let n = 1; n < knots.length; n++) {
      const a = knots[n - 1];
      const b = knots[n];
      const err = (fit[b] - built[b]) - (fit[a] - built[a]);
      const c = (err / ((b - a) * step)) * 100;
      for (let j = a; j < b; j++) next[j] += c;
    }
    grade = limit(next);
    built = integrate(fit[0], grade, step);
  }
  return { step, distances, heights: built };
}

export function buildViewProfile(course: Course, g: RouteGeometry): ViewProfile {
  const heights = new Float64Array(g.count);
  if (!course.hasElevation) return { heights, hasElevation: false, min: 0, max: 0 };

  const view = viewHeights(course.track.points);
  // The pipeline measures the raw track by haversine; the ride may use the
  // distances a FIT file carries. Map one onto the other in proportion so the
  // drawn road's ends meet the route's ends.
  const viewTotal = view.distances[view.distances.length - 1];
  const scale = g.total > 0 ? viewTotal / g.total : 1;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < g.count; i++) {
    const d = Math.min(viewTotal, g.distance[i] * scale);
    const k = Math.min(view.heights.length - 2, Math.floor(d / view.step));
    const f = view.step > 0 ? (d - view.distances[k]) / view.step : 0;
    const h = view.heights[k] + (view.heights[k + 1] - view.heights[k]) * f;
    heights[i] = h;
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  return { heights, hasElevation: true, min, max };
}

/** Drawn height at `distance`, unexaggerated. */
export function viewHeightAt(g: RouteGeometry, vp: ViewProfile, distance: number): number {
  return seriesAt(g, vp.heights, distance);
}

/** Drawn slope (rise over run, unexaggerated) at `distance`, over ±`span` metres. */
export function viewSlopeAt(g: RouteGeometry, vp: ViewProfile, distance: number, span = 5): number {
  const a = Math.max(0, distance - span);
  const b = Math.min(g.total, distance + span);
  if (b - a < 1e-6) return 0;
  return (viewHeightAt(g, vp, b) - viewHeightAt(g, vp, a)) / (b - a);
}
