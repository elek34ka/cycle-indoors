import { gradientColor } from './course';
import { gradientAt, type SmoothedProfile } from './smoothing';

/**
 * Where things are along a route, for the smoother's map. Every function takes
 * the route's GPS points with their cumulative distances from `routeDistances`,
 * the same pairing the smoothed GPX is built from, so the map, the charts and
 * the download all agree on where a distance is.
 */

export interface LatLon { lat: number; lon: number; }

/** A stretch of the route drawn in one colour. */
export interface GradientRun { color: string; latlngs: [number, number][]; }

const M_PER_DEG = (6371008.8 * Math.PI) / 180;

/** Index of the segment holding `distance`: distances[i] ≤ distance ≤ distances[i + 1]. */
function segmentAt(distances: number[], distance: number): number {
  let lo = 0;
  let hi = distances.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (distances[mid] <= distance) lo = mid; else hi = mid;
  }
  return lo;
}

/** The point `distance` metres along the route, clamped to its ends. */
export function positionAt(points: LatLon[], distances: number[], distance: number): LatLon {
  const total = distances[distances.length - 1];
  const d = Math.max(0, Math.min(total, distance));
  if (points.length === 1) return { lat: points[0].lat, lon: points[0].lon };
  const i = segmentAt(distances, d);
  const a = points[i];
  const b = points[i + 1];
  const span = distances[i + 1] - distances[i];
  const f = span > 0 ? (d - distances[i]) / span : 0;
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
}

/**
 * Distance along the route of the point on it nearest `lat`/`lon`. Each segment
 * is projected in a flat frame around the query point, which is exact enough
 * at the scale of a pointer on a map, and the foot's fraction of the segment
 * is applied to its haversine length.
 */
export function nearestDistance(points: LatLon[], distances: number[], lat: number, lon: number): number {
  const kx = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const ky = M_PER_DEG;
  let best = Infinity;
  let bestDistance = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const ax = (points[i].lon - lon) * kx;
    const ay = (points[i].lat - lat) * ky;
    const dx = (points[i + 1].lon - points[i].lon) * kx;
    const dy = (points[i + 1].lat - points[i].lat) * ky;
    const len2 = dx * dx + dy * dy;
    // the foot of the perpendicular from the origin (the query point)
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const fx = ax + dx * t;
    const fy = ay + dy * t;
    const gap = fx * fx + fy * fy;
    if (gap < best) {
      best = gap;
      bestDistance = distances[i] + (distances[i + 1] - distances[i]) * t;
    }
  }
  return points.length === 1 ? 0 : bestDistance;
}

/**
 * The route's GPS segments coloured by the smoothed gradient at each one's
 * middle, with neighbours of the same colour merged, so a 40 000-point route
 * is drawn as a few dozen lines. Each run starts where the previous one ended.
 */
export function gradientRuns(points: LatLon[], distances: number[], profile: SmoothedProfile): GradientRun[] {
  const runs: GradientRun[] = [];
  let current: GradientRun | undefined;
  for (let i = 0; i + 1 < points.length; i++) {
    const middle = (distances[i] + distances[i + 1]) / 2;
    const color = gradientColor(gradientAt(profile.smoothedGradient, profile.step, middle));
    const next: [number, number] = [points[i + 1].lat, points[i + 1].lon];
    if (current && current.color === color) {
      current.latlngs.push(next);
    } else {
      current = { color, latlngs: [[points[i].lat, points[i].lon], next] };
      runs.push(current);
    }
  }
  return runs;
}
