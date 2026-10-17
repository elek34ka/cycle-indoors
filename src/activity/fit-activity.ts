import { decodeFit, type FitFile } from '../fit/decoder';
import { fromFitTime } from '../fit/crc';
import { finaliseTrack, type ActivityTrack, type TrackPoint } from './types';

function nth(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Build a track from an already-decoded FIT activity or course file. */
export function trackFromFit(fit: FitFile, fallbackName: string): ActivityTrack {
  const records = fit.byName.get('record') ?? [];
  if (records.length === 0) throw new Error('FIT file contains no record messages');

  const points: TrackPoint[] = [];
  for (const rec of records) {
    const f = rec.fields;
    const lat = nth(f.position_lat);
    const lon = nth(f.position_long);
    const ts = nth(f.timestamp);
    const point: TrackPoint = {
      lat: lat ?? NaN,
      lon: lon ?? NaN,
      ele: nth(f.enhanced_altitude) ?? nth(f.altitude),
      time: ts !== undefined ? fromFitTime(ts).getTime() : undefined,
      distance: nth(f.distance) ?? 0,
      hr: nth(f.heart_rate),
      cadence: nth(f.cadence),
      power: nth(f.power),
      speed: nth(f.enhanced_speed) ?? nth(f.speed),
    };
    points.push(point);
  }

  const geo = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const session = fit.byName.get('session')?.[0]?.fields;
  const sportName = fit.byName.get('sport')?.[0]?.fields.name;
  const name = (typeof sportName === 'string' && sportName) || fallbackName;

  const known: Partial<ActivityTrack> = {
    distance: nth(session?.total_distance),
    elapsed: nth(session?.total_timer_time) ?? nth(session?.total_elapsed_time),
    avgPower: nth(session?.avg_power),
    maxPower: nth(session?.max_power),
    avgHr: nth(session?.avg_heart_rate),
    maxHr: nth(session?.max_heart_rate),
    avgSpeed: nth(session?.avg_speed),
    maxSpeed: nth(session?.max_speed),
    ascent: nth(session?.total_ascent),
    descent: nth(session?.total_descent),
  };
  // Stats come from every record, not just the ones carrying GPS, so a
  // trainer ride with no position data still reports power/HR correctly.
  const agg = (pick: (p: TrackPoint) => number | undefined) => {
    const v = points.map(pick).filter((x): x is number => x !== undefined && Number.isFinite(x));
    return v.length ? { avg: v.reduce((s, x) => s + x, 0) / v.length, max: Math.max(...v) } : undefined;
  };
  const pw = agg((p) => p.power);
  const hr = agg((p) => p.hr);
  known.avgPower ??= pw?.avg;
  known.maxPower ??= pw?.max;
  known.avgHr ??= hr?.avg;
  known.maxHr ??= hr?.max;
  known.hasPower = pw !== undefined;
  known.hasHr = hr !== undefined;
  known.distance ??= points[points.length - 1]?.distance || undefined;

  for (const key of Object.keys(known) as (keyof ActivityTrack)[]) {
    if (known[key] === undefined) delete known[key];
  }

  // No GPS in the file (a trainer ride): still return the stream so the
  // summary/graph can use it, with an empty point list for the map.
  return finaliseTrack(name, 'fit', geo.length >= 2 ? geo : [], known);
}

export function parseFitActivity(buffer: ArrayBuffer, fallbackName: string): ActivityTrack {
  return trackFromFit(decodeFit(buffer), fallbackName);
}
