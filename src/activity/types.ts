export interface TrackPoint {
  lat: number;
  lon: number;
  ele?: number;
  /** unix ms */
  time?: number;
  /** cumulative metres from the start */
  distance: number;
  hr?: number;
  power?: number;
  cadence?: number;
  /** m/s */
  speed?: number;
}

export interface ActivityTrack {
  name: string;
  source: 'gpx' | 'fit';
  points: TrackPoint[];
  distance: number;
  ascent: number;
  descent: number;
  elapsed?: number;
  startTime?: number;
  avgPower?: number;
  maxPower?: number;
  avgHr?: number;
  maxHr?: number;
  avgSpeed?: number;
  maxSpeed?: number;
  minEle?: number;
  maxEle?: number;
  hasPower: boolean;
  hasHr: boolean;
  hasElevation: boolean;
}

const EARTH_RADIUS = 6371008.8;

export function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Fill in cumulative distance and derive the roll-up stats for a point list. */
export function finaliseTrack(
  name: string,
  source: ActivityTrack['source'],
  points: TrackPoint[],
  known: Partial<ActivityTrack> = {},
): ActivityTrack {
  let distance = known.distance ?? 0;
  const hasPresetDistance = points.some((p) => p.distance > 0);

  if (!hasPresetDistance) {
    let acc = 0;
    for (let i = 0; i < points.length; i++) {
      if (i > 0) acc += haversine(points[i - 1], points[i]);
      points[i].distance = acc;
    }
    distance = acc;
  } else {
    distance = points[points.length - 1]?.distance ?? distance;
  }

  // Smooth elevation before counting climb, so GPS noise does not inflate total
  // ascent by hundreds of metres. Short tracks are left alone — a 5-point window
  // over a handful of points would flatten the profile completely.
  const eles = points.map((p) => p.ele);
  const half = points.length >= 20 ? 2 : 0;
  const smoothed: (number | undefined)[] = eles.map((_, i) => {
    if (half === 0) return eles[i];
    const window = eles.slice(Math.max(0, i - half), i + half + 1).filter((v): v is number => v !== undefined);
    return window.length ? window.reduce((s, v) => s + v, 0) / window.length : undefined;
  });

  let ascent = 0;
  let descent = 0;
  let minEle: number | undefined;
  let maxEle: number | undefined;
  for (let i = 0; i < smoothed.length; i++) {
    const e = smoothed[i];
    if (e === undefined) continue;
    minEle = minEle === undefined ? e : Math.min(minEle, e);
    maxEle = maxEle === undefined ? e : Math.max(maxEle, e);
    const prev = smoothed[i - 1];
    if (prev === undefined) continue;
    const d = e - prev;
    if (d > 0) ascent += d; else descent -= d;
  }

  const stat = (pick: (p: TrackPoint) => number | undefined) => {
    const values = points.map(pick).filter((v): v is number => v !== undefined && Number.isFinite(v));
    if (!values.length) return { avg: undefined, max: undefined, count: 0 };
    return {
      avg: values.reduce((s, v) => s + v, 0) / values.length,
      max: Math.max(...values),
      count: values.length,
    };
  };

  const pw = stat((p) => p.power);
  const hr = stat((p) => p.hr);
  const sp = stat((p) => p.speed);

  const times = points.map((p) => p.time).filter((t): t is number => t !== undefined);
  const startTime = times.length ? Math.min(...times) : undefined;
  const elapsed = times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 1000 : undefined;

  return {
    name,
    source,
    distance,
    ascent,
    descent,
    elapsed: known.elapsed ?? elapsed,
    startTime,
    avgPower: pw.avg,
    maxPower: pw.max,
    avgHr: hr.avg,
    maxHr: hr.max,
    avgSpeed: sp.avg ?? (elapsed ? distance / elapsed : undefined),
    maxSpeed: sp.max,
    minEle,
    maxEle,
    hasPower: pw.count > 0,
    hasHr: hr.count > 0,
    hasElevation: minEle !== undefined,
    ...known,
    points,
  };
}
