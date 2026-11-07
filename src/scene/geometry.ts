import type { Course } from '../activity/course';
import { positionAt } from '../activity/route-geometry';

/**
 * A route as the 3D view sees it: one slice every `step` metres along the
 * ride's own distance, placed in local metres around the route's first point.
 *
 * Axes follow three.js with y up: x is east, z is south (so north is −z).
 * The tangent points along the direction of travel and the right vector is
 * the horizontal direction to the rider's right, `(−tz, tx)`.
 */
export interface RouteGeometry {
  /** metres between slices; the last slice may be closer to its neighbour */
  step: number;
  count: number;
  /** total distance of the route, as the ride measures it */
  total: number;
  /** metres along the route of each slice */
  distance: Float64Array;
  x: Float64Array;
  z: Float64Array;
  /** unit tangent in the direction of travel */
  tx: Float64Array;
  tz: Float64Array;
  /** unit vector to the right of travel */
  rx: Float64Array;
  rz: Float64Array;
  origin: { lat: number; lon: number };
}

export const SLICE_STEP = 10;
const M_PER_DEG = (6371008.8 * Math.PI) / 180;

/** Local metres around `origin`: equirectangular, exact enough at route scale. */
export function projector(origin: { lat: number; lon: number }): (lat: number, lon: number) => [number, number] {
  const kx = M_PER_DEG * Math.cos((origin.lat * Math.PI) / 180);
  return (lat, lon) => [(lon - origin.lon) * kx, -(lat - origin.lat) * M_PER_DEG];
}

export function buildGeometry(course: Course, step = SLICE_STEP): RouteGeometry {
  const points = course.points;
  const distances = points.map((p) => p.distance);
  const total = course.totalDistance;
  const count = Math.max(2, Math.floor(total / step) + (total % step > 1e-6 ? 2 : 1));
  const origin = { lat: points[0].lat, lon: points[0].lon };
  const project = projector(origin);

  const distance = new Float64Array(count);
  const x = new Float64Array(count);
  const z = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const d = Math.min(total, i * step);
    distance[i] = d;
    const p = positionAt(points, distances, d);
    [x[i], z[i]] = project(p.lat, p.lon);
  }

  const tx = new Float64Array(count);
  const tz = new Float64Array(count);
  let lastX = 1;
  let lastZ = 0;
  for (let i = 0; i < count; i++) {
    // Centred difference; at a point where the route doubles back exactly the
    // two neighbours coincide, so fall back to the forward step, then to the
    // last good tangent.
    const candidates: [number, number][] = [
      [x[Math.min(count - 1, i + 1)] - x[Math.max(0, i - 1)], z[Math.min(count - 1, i + 1)] - z[Math.max(0, i - 1)]],
      [x[Math.min(count - 1, i + 1)] - x[i], z[Math.min(count - 1, i + 1)] - z[i]],
      [x[i] - x[Math.max(0, i - 1)], z[i] - z[Math.max(0, i - 1)]],
    ];
    for (const [dx, dz] of candidates) {
      const len = Math.hypot(dx, dz);
      if (len > 1e-3) { lastX = dx / len; lastZ = dz / len; break; }
    }
    tx[i] = lastX;
    tz[i] = lastZ;
  }
  const rx = new Float64Array(count);
  const rz = new Float64Array(count);
  for (let i = 0; i < count; i++) { rx[i] = -tz[i]; rz[i] = tx[i]; }

  return { step, count, total, distance, x, z, tx, tz, rx, rz, origin };
}

/** The slice holding `distance` and how far into it, clamped to the route. */
export function sliceAt(g: RouteGeometry, distance: number): { i: number; f: number } {
  const d = Math.max(0, Math.min(g.total, distance));
  let i = Math.min(g.count - 2, Math.floor(d / g.step));
  if (i < 0) i = 0;
  const span = g.distance[i + 1] - g.distance[i];
  return { i, f: span > 0 ? Math.min(1, (d - g.distance[i]) / span) : 0 };
}

/** A per-slice series interpolated at `distance`. */
export function seriesAt(g: RouteGeometry, series: ArrayLike<number>, distance: number): number {
  const { i, f } = sliceAt(g, distance);
  return series[i] + (series[i + 1] - series[i]) * f;
}

/** Horizontal position along the route at `distance`. */
export function positionAlong(g: RouteGeometry, distance: number): { x: number; z: number } {
  return { x: seriesAt(g, g.x, distance), z: seriesAt(g, g.z, distance) };
}

/** The route's own heading (radians, atan2(tz, tx)) at `distance`, over ±`span` metres. */
export function headingAt(g: RouteGeometry, distance: number, span = 6): number {
  const a = positionAlong(g, distance - span);
  const b = positionAlong(g, distance + span);
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (Math.hypot(dx, dz) > 1e-3) return Math.atan2(dz, dx);
  const { i } = sliceAt(g, distance);
  return Math.atan2(g.tz[i], g.tx[i]);
}

/** Summed straight-line length of the slices, for checking against `total`. */
export function sliceLength(g: RouteGeometry): number {
  let sum = 0;
  for (let i = 1; i < g.count; i++) sum += Math.hypot(g.x[i] - g.x[i - 1], g.z[i] - g.z[i - 1]);
  return sum;
}

/**
 * A seed that depends only on the route's shape, so the same route always
 * grows the same land and scenery, and nothing random is stored or sent.
 */
export function routeSeed(g: RouteGeometry): number {
  let h = 2166136261 ^ g.count;
  const stride = Math.max(1, Math.floor(g.count / 64));
  for (let i = 0; i < g.count; i += stride) {
    h = Math.imul(h ^ Math.round(g.x[i]), 16777619);
    h = Math.imul(h ^ Math.round(g.z[i]), 16777619);
  }
  return h >>> 0;
}
