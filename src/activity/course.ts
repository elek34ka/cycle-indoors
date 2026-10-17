import type { ActivityTrack } from './types';

export interface CourseSample {
  /** metres from the course start */
  distance: number;
  lat: number;
  lon: number;
  ele: number;
  /** road gradient in percent at this point */
  gradient: number;
  /** cumulative metres climbed up to this point */
  ascent: number;
}

export interface CoursePosition extends CourseSample {
  /** 0-1 along the current lap */
  ratio: number;
  index: number;
  /** completed laps of the course */
  loops: number;
  /** ascent including every completed lap */
  totalAscent: number;
}

/** Half-window used to smooth elevation, in metres of travel. GPS altitude is
 *  noisy at the metre scale; gradient computed from raw samples is unusable. */
const SMOOTH_HALF_WINDOW = 30;
/** Minimum run used to measure a gradient, in metres. */
const GRADIENT_SPAN = 40;
const MAX_GRADIENT = 25;

function binarySearch(distances: number[], target: number): number {
  let lo = 0;
  let hi = distances.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (distances[mid] <= target) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** A loaded route turned into something rideable: elevation smoothed, gradient
 *  and cumulative ascent precomputed, and lookup by distance travelled. */
export class Course {
  readonly name: string;
  readonly points: CourseSample[];
  readonly totalDistance: number;
  readonly totalAscent: number;
  readonly totalDescent: number;
  readonly minEle: number;
  readonly maxEle: number;
  readonly hasElevation: boolean;
  private readonly distances: number[];

  constructor(readonly track: ActivityTrack) {
    const source = track.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (source.length < 2) throw new Error('A course needs at least two GPS points');

    const eles = source.map((p) => p.ele);
    this.hasElevation = eles.some((e) => e !== undefined);

    // Distance-based smoothing window, so the result does not depend on how
    // densely the device logged.
    const smoothed: number[] = source.map((p, i) => {
      if (!this.hasElevation) return 0;
      let sum = 0;
      let count = 0;
      for (let j = i; j >= 0 && p.distance - source[j].distance <= SMOOTH_HALF_WINDOW; j--) {
        if (eles[j] !== undefined) { sum += eles[j]!; count++; }
      }
      for (let j = i + 1; j < source.length && source[j].distance - p.distance <= SMOOTH_HALF_WINDOW; j++) {
        if (eles[j] !== undefined) { sum += eles[j]!; count++; }
      }
      return count ? sum / count : (eles[i] ?? 0);
    });

    let ascent = 0;
    let descent = 0;
    const points: CourseSample[] = source.map((p, i) => {
      if (i > 0) {
        const delta = smoothed[i] - smoothed[i - 1];
        if (delta > 0) ascent += delta; else descent -= delta;
      }
      return { distance: p.distance, lat: p.lat, lon: p.lon, ele: smoothed[i], gradient: 0, ascent };
    });

    // Gradient over a fixed run of road, centred on each point.
    for (let i = 0; i < points.length; i++) {
      let lo = i;
      let hi = i;
      while (lo > 0 && points[i].distance - points[lo].distance < GRADIENT_SPAN / 2) lo--;
      while (hi < points.length - 1 && points[hi].distance - points[i].distance < GRADIENT_SPAN / 2) hi++;
      const run = points[hi].distance - points[lo].distance;
      const rise = points[hi].ele - points[lo].ele;
      points[i].gradient = run > 1 ? Math.max(-MAX_GRADIENT, Math.min(MAX_GRADIENT, (rise / run) * 100)) : 0;
    }

    this.name = track.name;
    this.points = points;
    this.distances = points.map((p) => p.distance);
    this.totalDistance = points[points.length - 1].distance;
    this.totalAscent = ascent;
    this.totalDescent = descent;
    this.minEle = Math.min(...smoothed);
    this.maxEle = Math.max(...smoothed);
  }

  indexForDistance(distance: number): number {
    return binarySearch(this.distances, Math.max(0, Math.min(this.totalDistance, distance)));
  }

  /** Position after riding `distance` metres, lapping the course if it runs out. */
  at(distance: number): CoursePosition {
    const total = this.totalDistance;
    const loops = total > 0 ? Math.floor(Math.max(0, distance) / total) : 0;
    const local = total > 0 ? Math.max(0, distance) - loops * total : 0;
    const i = this.indexForDistance(local);
    const a = this.points[i];
    const b = this.points[Math.min(this.points.length - 1, i + 1)];
    const span = b.distance - a.distance;
    const f = span > 0 ? (local - a.distance) / span : 0;
    const lerp = (x: number, y: number) => x + (y - x) * f;

    return {
      distance: local,
      lat: lerp(a.lat, b.lat),
      lon: lerp(a.lon, b.lon),
      ele: lerp(a.ele, b.ele),
      gradient: lerp(a.gradient, b.gradient),
      ascent: lerp(a.ascent, b.ascent),
      totalAscent: loops * this.totalAscent + lerp(a.ascent, b.ascent),
      ratio: total > 0 ? local / total : 0,
      index: i,
      loops,
    };
  }
}

/** Gradient colour scale, shared by the elevation profile and its readout. */
const GRADIENT_STOPS: { max: number; color: string }[] = [
  { max: -3, color: '#5bc8f5' },
  { max: 1, color: '#7a8694' },
  { max: 4, color: '#3fc07a' },
  { max: 7, color: '#f0c33c' },
  { max: 10, color: '#f08a35' },
  { max: 15, color: '#e4563c' },
  { max: Infinity, color: '#b02a7a' },
];

export function gradientColor(gradient: number): string {
  for (const stop of GRADIENT_STOPS) if (gradient <= stop.max) return stop.color;
  return GRADIENT_STOPS[GRADIENT_STOPS.length - 1].color;
}
