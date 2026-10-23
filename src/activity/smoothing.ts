import { haversine, type ActivityTrack } from './types';

/**
 * Elevation smoothing for routes ridden on a trainer. Raw GPS altitude turns
 * into a gradient that jumps every few metres, and in simulation mode the
 * trainer's brake follows every jump. The pipeline below produces a profile
 * whose gradient is guaranteed to stay inside the rider's limits and to change
 * no faster than they allow, while still starting and finishing at the
 * route's own heights.
 *
 * Every window and limit is in metres of road, never in GPS points, because
 * devices log points at whatever spacing they like.
 */

export interface SmoothingParams {
  /** resample spacing, metres */
  spacing: number;
  /** Hampel threshold, in robust standard deviations (1.4826 × MAD) */
  spikeThreshold: number;
  /** Savitzky–Golay window, an odd number of resampled points */
  window: number;
  /** largest change in gradient allowed, percentage points per 10 m */
  maxChange: number;
  /** steepest descent allowed, percent (≤ 0) */
  minGradient: number;
  /** steepest climb allowed, percent (≥ 0) */
  maxGradient: number;
}

export type SmoothingPresetName = 'light' | 'medium' | 'strong';
export type SmoothingPreset = SmoothingPresetName | 'custom';

export const PRESETS: Record<SmoothingPresetName, SmoothingParams> = {
  light: { spacing: 10, spikeThreshold: 4, window: 5, maxChange: 1.5, minGradient: -20, maxGradient: 20 },
  medium: { spacing: 10, spikeThreshold: 3, window: 9, maxChange: 1, minGradient: -15, maxGradient: 15 },
  strong: { spacing: 10, spikeThreshold: 3, window: 15, maxChange: 0.5, minGradient: -12, maxGradient: 12 },
};

export const PRESET_LABELS: Record<SmoothingPreset, string> = {
  light: 'Light', medium: 'Medium', strong: 'Strong', custom: 'Custom',
};

export interface ParamSpec {
  key: keyof SmoothingParams;
  label: string;
  min: number;
  max: number;
  step: number;
  suffix: string;
}

export const PARAM_SPECS: ParamSpec[] = [
  { key: 'spacing', label: 'Resample spacing', min: 5, max: 50, step: 1, suffix: 'm between samples' },
  { key: 'spikeThreshold', label: 'Spike threshold', min: 2, max: 10, step: 0.5, suffix: 'lower removes more spikes' },
  { key: 'window', label: 'Smoothing window', min: 3, max: 51, step: 2, suffix: 'points, odd' },
  { key: 'maxChange', label: 'Max gradient change', min: 0.1, max: 5, step: 0.1, suffix: '% per 10 m' },
  { key: 'minGradient', label: 'Min gradient', min: -30, max: 0, step: 0.5, suffix: '% — steepest descent' },
  { key: 'maxGradient', label: 'Max gradient', min: 0, max: 30, step: 0.5, suffix: '% — steepest climb' },
];

/** Round the window up to the next odd number; everything else is left as given. */
export function normaliseParams(params: SmoothingParams): SmoothingParams {
  const window = Math.round(params.window);
  return { ...params, window: window % 2 === 0 ? window + 1 : window };
}

/** Why these parameters cannot be used, or undefined if they can. Checks the
 *  normalised values, so an even window is judged by the odd one it becomes. */
export function validateParams(params: SmoothingParams): string | undefined {
  const p = normaliseParams(params);
  for (const spec of PARAM_SPECS) {
    const v = p[spec.key];
    if (!Number.isFinite(v) || v < spec.min || v > spec.max) {
      return `${spec.label} must be between ${spec.min} and ${spec.max}`;
    }
  }
  if (p.minGradient >= p.maxGradient) return 'Min gradient must be below max gradient';
  return undefined;
}

/** Why a track cannot be smoothed, or undefined if it can. */
export function routeProblem(track: ActivityTrack): string | undefined {
  const located = track.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (located.length < 2) return 'This file has no route: it needs at least two GPS points';
  if (!located.some((p) => p.ele !== undefined && Number.isFinite(p.ele))) {
    return 'This route has no elevation to smooth';
  }
  if (routeDistances(located).at(-1)! <= 0) return 'This route has no length';
  return undefined;
}

/** Cumulative haversine distance along the points. Any distance a FIT file
 *  carries is ignored, because the exported GPX has none and its loader
 *  recomputes this, so both must agree on where each height belongs. */
export function routeDistances(points: { lat: number; lon: number }[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) acc += haversine(points[i - 1], points[i]);
    out.push(acc);
  }
  return out;
}

export interface Resampled {
  /** exact spacing used: the requested spacing shrunk to divide the route evenly */
  step: number;
  distances: number[];
  elevations: number[];
}

/** Linear interpolation of elevation onto an even grid from 0 to the route's
 *  total distance. Points with no elevation are skipped; before the first and
 *  after the last known height, the nearest one is held. */
export function resample(distances: number[], eles: (number | undefined)[], spacing: number): Resampled {
  const known: { d: number; e: number }[] = [];
  for (let i = 0; i < distances.length; i++) {
    const e = eles[i];
    if (e !== undefined && Number.isFinite(e)) known.push({ d: distances[i], e });
  }
  if (known.length === 0) throw new Error('No elevation to resample');
  const total = distances[distances.length - 1];
  const n = Math.max(1, Math.ceil(total / spacing - 1e-9));
  const step = total / n;

  const out: number[] = [];
  const grid: number[] = [];
  let j = 0;
  for (let k = 0; k <= n; k++) {
    const d = k === n ? total : k * step;
    grid.push(d);
    while (j < known.length - 1 && known[j + 1].d < d) j++;
    const a = known[j];
    const b = known[Math.min(known.length - 1, j + 1)];
    if (d <= a.d || b.d <= a.d) out.push(d <= a.d ? a.e : b.e);
    else if (d >= b.d) out.push(b.e);
    else out.push(a.e + ((b.e - a.e) * (d - a.d)) / (b.d - a.d));
  }
  return { step, distances: grid, elevations: out };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Spikes are judged against the road within this distance either side. */
const SPIKE_HALF_WINDOW = 50;
/** A deviation smaller than this is never a spike. Without it a flat road
 *  (MAD ≈ 0) would flag ordinary sub-metre noise. */
const SPIKE_FLOOR = 2;

/** Hampel filter: a sample far outside its neighbours' median, by robust
 *  standard deviations, is replaced by that median. Judged against the input,
 *  not against already-repaired samples. */
export function removeSpikes(values: number[], step: number, threshold: number): number[] {
  const half = Math.max(1, Math.round(SPIKE_HALF_WINDOW / step));
  return values.map((v, i) => {
    const window = values.slice(Math.max(0, i - half), i + half + 1);
    const med = median(window);
    const mad = median(window.map((x) => Math.abs(x - med)));
    return Math.abs(v - med) > Math.max(SPIKE_FLOOR, threshold * 1.4826 * mad) ? med : v;
  });
}

/** Least-squares quadratic through values[start .. start+count), evaluated at index `at`. */
function quadraticAt(values: number[], start: number, count: number, at: number): number {
  // Centre x on the window to keep the normal equations well conditioned.
  const c = start + (count - 1) / 2;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let k = 0; k < count; k++) {
    const x = start + k - c;
    const y = values[start + k];
    const x2 = x * x;
    s0 += 1; s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
    t0 += y; t1 += x * y; t2 += x2 * y;
  }
  // Solve [s0 s1 s2; s1 s2 s3; s2 s3 s4] · [a b q] = [t0 t1 t2] by Cramer's rule.
  const det3 = (m: number[]) =>
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const M = [s0, s1, s2, s1, s2, s3, s2, s3, s4];
  const D = det3(M);
  const a = det3([t0, s1, s2, t1, s2, s3, t2, s3, s4]) / D;
  const b = det3([s0, t0, s2, s1, t1, s3, s2, t2, s4]) / D;
  const q = det3([s0, s1, t0, s1, s2, t1, s2, s3, t2]) / D;
  const x = at - c;
  return a + b * x + q * x * x;
}

/** Savitzky–Golay smoothing with a quadratic over `window` samples. Within half
 *  a window of either end there is no centred window, so the quadratic fitted
 *  to the first (or last) full window is evaluated there instead: lines and
 *  parabolas pass through untouched, right up to the ends. */
export function savitzkyGolay(values: number[], window: number): number[] {
  let w = Math.min(window, values.length % 2 ? values.length : values.length - 1);
  if (w < 3) return [...values];
  if (w % 2 === 0) w--;
  const m = (w - 1) / 2;
  const denom = (2 * m + 1) * (4 * m * m + 4 * m - 3);
  const coeff: number[] = [];
  for (let j = -m; j <= m; j++) coeff.push((3 * (3 * m * m + 3 * m - 1 - 5 * j * j)) / denom);

  const n = values.length;
  return values.map((_, i) => {
    if (i < m) return quadraticAt(values, 0, w, i);
    if (i >= n - m) return quadraticAt(values, n - w, w, i);
    let sum = 0;
    for (let j = -m; j <= m; j++) sum += coeff[j + m] * values[i + j];
    return sum;
  });
}

/** Gradient of each segment, percent. */
export function gradients(elevations: number[], step: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < elevations.length; i++) out.push(((elevations[i + 1] - elevations[i]) / step) * 100);
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Limit how fast the gradient may change: no neighbouring pair of segments
 * differs by more than `delta`. A forward pass alone would make every climb
 * start late and end late, so it is followed by a backward pass, after which
 * every pair holds. Each value ends up between its old value and a neighbour
 * that is within [lo, hi], so a clamp applied beforehand still holds.
 */
export function limitChange(grade: number[], delta: number): number[] {
  const g = [...grade];
  for (let i = 1; i < g.length; i++) g[i] = clamp(g[i], g[i - 1] - delta, g[i - 1] + delta);
  for (let i = g.length - 2; i >= 0; i--) g[i] = clamp(g[i], g[i + 1] - delta, g[i + 1] + delta);
  return g;
}

function integrate(start: number, grade: number[], step: number): number[] {
  const out = [start];
  for (const g of grade) out.push(out[out.length - 1] + (g / 100) * step);
  return out;
}

/** Start and finish heights are the median of the original points within this distance of each end. */
const ANCHOR_SPAN = 50;
/** A residual this small counts as reaching the finish. */
const ANCHOR_TOLERANCE = 0.1;
/** Beyond this the limits are reported as unable to reach the finish height. */
const ANCHOR_WARNING = 1;

export interface ProfileStats {
  ascent: number;
  descent: number;
  maxGradient: number;
  minGradient: number;
  /** largest change between neighbouring segments, percentage points per 10 m */
  maxChange: number;
  startShift: number;
  finishShift: number;
}

export function profileStats(
  elevations: number[],
  grade: number[],
  step: number,
  anchors: { start: number; finish: number },
): ProfileStats {
  let ascent = 0;
  let descent = 0;
  for (let i = 1; i < elevations.length; i++) {
    const d = elevations[i] - elevations[i - 1];
    if (d > 0) ascent += d; else descent -= d;
  }
  let maxChange = 0;
  let maxGradient = grade.length ? -Infinity : 0;
  let minGradient = grade.length ? Infinity : 0;
  for (let i = 0; i < grade.length; i++) {
    if (i > 0) maxChange = Math.max(maxChange, Math.abs(grade[i] - grade[i - 1]));
    maxGradient = Math.max(maxGradient, grade[i]);
    minGradient = Math.min(minGradient, grade[i]);
  }
  return {
    ascent,
    descent,
    maxGradient,
    minGradient,
    maxChange: (maxChange * 10) / step,
    startShift: elevations[0] - anchors.start,
    finishShift: elevations[elevations.length - 1] - anchors.finish,
  };
}

export interface SmoothedProfile {
  params: SmoothingParams;
  step: number;
  distances: number[];
  /** the raw elevation, resampled; what the rider would feel unsmoothed */
  original: number[];
  smoothed: number[];
  /** per segment, between distances[i] and distances[i + 1] */
  originalGradient: number[];
  smoothedGradient: number[];
  anchors: { start: number; finish: number };
  /** metres the finish still misses by when the limits cannot reach it; undefined when it is reached */
  anchorShortfall: number | undefined;
  stats: { original: ProfileStats; smoothed: ProfileStats };
}

function anchorHeight(distances: number[], eles: (number | undefined)[], from: number, to: number, fallback: number): number {
  const inSpan: number[] = [];
  for (let i = 0; i < distances.length; i++) {
    const e = eles[i];
    // a micrometre of slack: haversine puts the point at 50 m at 50.0000000001
    const inside = distances[i] >= from - 1e-6 && distances[i] <= to + 1e-6;
    if (inside && e !== undefined && Number.isFinite(e)) inSpan.push(e);
  }
  return inSpan.length ? median(inSpan) : fallback;
}

/** The whole pipeline: resample, remove spikes, smooth, limit gradient and its
 *  change, rebuild, and re-anchor the finish. */
export function smoothProfile(track: ActivityTrack, input: SmoothingParams): SmoothedProfile {
  const problem = routeProblem(track) ?? validateParams(input);
  if (problem) throw new Error(problem);
  const params = normaliseParams(input);

  const points = track.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const dist = routeDistances(points);
  const eles = points.map((p) => p.ele);
  const { step, distances, elevations: original } = resample(dist, eles, params.spacing);
  const total = distances[distances.length - 1];

  const anchors = {
    start: anchorHeight(dist, eles, 0, ANCHOR_SPAN, original[0]),
    finish: anchorHeight(dist, eles, total - ANCHOR_SPAN, total, original[original.length - 1]),
  };

  const cleaned = removeSpikes(original, step, params.spikeThreshold);
  const smooth = savitzkyGolay(cleaned, params.window);
  const delta = (params.maxChange * step) / 10;
  let grade = limitChange(
    gradients(smooth, step).map((g) => clamp(g, params.minGradient, params.maxGradient)),
    delta,
  );

  // Re-anchor the finish. A constant added to every gradient leaves the
  // differences between neighbours alone, and a clamp never widens them, so
  // the change limit survives every round. Segments already at the limit in
  // the needed direction cannot help, so the correction is sized for the rest.
  let built = integrate(anchors.start, grade, step);
  for (let round = 0; round < 20; round++) {
    const residual = anchors.finish - built[built.length - 1];
    if (Math.abs(residual) < ANCHOR_TOLERANCE) break;
    const free = grade.filter((g) => (residual > 0 ? g < params.maxGradient : g > params.minGradient)).length * step;
    if (free <= 0) break;
    const c = (residual / free) * 100;
    grade = grade.map((g) => clamp(g + c, params.minGradient, params.maxGradient));
    built = integrate(anchors.start, grade, step);
  }
  const shortfall = anchors.finish - built[built.length - 1];

  const originalGradient = gradients(original, step);
  return {
    params,
    step,
    distances,
    original,
    smoothed: built,
    originalGradient,
    smoothedGradient: grade,
    anchors,
    anchorShortfall: Math.abs(shortfall) > ANCHOR_WARNING ? shortfall : undefined,
    stats: {
      original: profileStats(original, originalGradient, step, anchors),
      smoothed: profileStats(built, grade, step, anchors),
    },
  };
}

/** Linear interpolation of a series over the profile's even grid. */
export function valueAt(profile: SmoothedProfile, series: number[], distance: number): number {
  const d = clamp(distance, 0, profile.distances[profile.distances.length - 1]);
  const i = Math.min(series.length - 2, Math.floor(d / profile.step));
  if (i < 0) return series[0];
  const f = (d - profile.distances[i]) / profile.step;
  return series[i] + (series[i + 1] - series[i]) * f;
}

/** Gradient of the segment holding `distance`. */
export function gradientAt(grade: number[], step: number, distance: number): number {
  return grade[clamp(Math.floor(distance / step), 0, grade.length - 1)] ?? 0;
}
