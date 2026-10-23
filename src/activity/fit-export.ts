import { FitEncoder, type FieldSpec } from '../fit/encoder';
import { toFitTime } from '../fit/crc';
import type { Lap } from '../session/session';
import type { RideMetrics, Sample } from '../session/metrics';

const LOCAL = { fileId: 0, event: 1, record: 2, lap: 3, session: 4, activity: 5, sport: 6 } as const;

const SPORT_CYCLING = 2;
const SUB_SPORT_INDOOR_CYCLING = 6;
/** Riding a GPS route on a trainer is a virtual ride, and platforms that know
 *  this sub-sport will draw the map and label it correctly. */
const SUB_SPORT_VIRTUAL_ACTIVITY = 58;
/** FIT stores latitude and longitude as semicircles. */
const SEMICIRCLES_PER_DEGREE = 2 ** 31 / 180;
const EVENT_TIMER = 0;
const EVENT_LAP = 9;
const EVENT_SESSION = 8;
const EVENT_ACTIVITY = 26;
const EVENT_TYPE_START = 0;
const EVENT_TYPE_STOP = 1;
const EVENT_TYPE_STOP_ALL = 4;
/** FIT manufacturer id 255 = "development" — the honest choice for a hobby app. */
const MANUFACTURER_DEVELOPMENT = 255;

export interface ExportOptions {
  startedAt: Date;
  samples: readonly Sample[];
  laps: readonly Lap[];
  metrics: RideMetrics;
  name: string;
}

function slice(samples: readonly Sample[], from: number, to: number): Sample[] {
  return samples.filter((s) => s.t > from && s.t <= to);
}

function semicircles(degrees: number | undefined): number | null {
  if (degrees === undefined || !Number.isFinite(degrees)) return null;
  return Math.round(degrees * SEMICIRCLES_PER_DEGREE);
}

/** Altitude is stored as (metres + 500) x 5 in an unsigned 16-bit field. */
function fitAltitude(metres: number | undefined): number | null {
  if (metres === undefined || !Number.isFinite(metres)) return null;
  return Math.round((Math.max(-500, Math.min(12000, metres)) + 500) * 5);
}

function climbIn(samples: Sample[]): { ascent: number; descent: number } {
  let ascent = 0;
  let descent = 0;
  let previous: number | undefined;
  for (const s of samples) {
    if (s.altitude === undefined) continue;
    if (previous !== undefined) {
      const delta = s.altitude - previous;
      if (Math.abs(delta) <= 8) {
        if (delta > 0) ascent += delta; else descent -= delta;
      }
    }
    previous = s.altitude;
  }
  return { ascent, descent };
}

function lapStats(samples: Sample[]) {
  const powers = samples.map((s) => s.power);
  const hrs = samples.map((s) => s.heartRate).filter((v): v is number => v !== undefined && v > 0);
  const cads = samples.map((s) => s.cadence).filter((v): v is number => v !== undefined);
  const speeds = samples.map((s) => s.speed).filter((v): v is number => v !== undefined);
  const avg = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : undefined);
  return {
    avgPower: avg(powers),
    maxPower: powers.length ? Math.max(...powers) : undefined,
    avgHr: avg(hrs),
    maxHr: hrs.length ? Math.max(...hrs) : undefined,
    avgCadence: avg(cads),
    maxCadence: cads.length ? Math.max(...cads) : undefined,
    avgSpeed: avg(speeds),
    maxSpeed: speeds.length ? Math.max(...speeds) : undefined,
    calories: Math.round(powers.reduce((s, v) => s + v, 0) / 1000),
  };
}

/** Encode the recorded ride as a FIT activity file, ready for Strava or intervals.icu. */
export function buildActivityFit(opts: ExportOptions): Uint8Array {
  const { startedAt, samples, metrics } = opts;
  const enc = new FitEncoder();
  const startFit = toFitTime(startedAt);
  const timeOf = (t: number) => startFit + Math.round(t);
  const endFit = timeOf(samples.length ? samples[samples.length - 1].t : 0);

  enc.message(LOCAL.fileId, 0, [
    { num: 0, type: 'enum', value: 4 }, // activity file
    { num: 1, type: 'uint16', value: MANUFACTURER_DEVELOPMENT },
    { num: 2, type: 'uint16', value: 0 },
    { num: 3, type: 'uint32z', value: Math.floor(startedAt.getTime() / 1000) % 0xffffffff },
    { num: 4, type: 'uint32', value: startFit },
    { num: 8, type: 'string', value: 'Cycle Indoors', size: 14 },
  ]);

  enc.message(LOCAL.event, 21, [
    { num: 253, type: 'uint32', value: startFit },
    { num: 0, type: 'enum', value: EVENT_TIMER },
    { num: 1, type: 'enum', value: EVENT_TYPE_START },
  ]);

  // The record layout is fixed for the whole file, so position and altitude
  // fields are only declared when the ride actually followed a route.
  for (const s of samples) {
    const fields: FieldSpec[] = [
      { num: 253, type: 'uint32', value: timeOf(s.t) },
      { num: 5, type: 'uint32', value: Math.round(s.distance * 100) },
      { num: 6, type: 'uint16', value: s.speed === undefined ? null : Math.round((s.speed / 3.6) * 1000) },
      { num: 7, type: 'uint16', value: Math.round(s.power) },
      { num: 3, type: 'uint8', value: s.heartRate ?? null },
      { num: 4, type: 'uint8', value: s.cadence ?? null },
    ];
    if (metrics.hasPosition) {
      fields.push(
        { num: 0, type: 'sint32', value: semicircles(s.lat) },
        { num: 1, type: 'sint32', value: semicircles(s.lon) },
        { num: 2, type: 'uint16', value: fitAltitude(s.altitude) },
      );
    }
    enc.message(LOCAL.record, 20, fields);
  }

  enc.message(LOCAL.event, 21, [
    { num: 253, type: 'uint32', value: endFit },
    { num: 0, type: 'enum', value: EVENT_TIMER },
    { num: 1, type: 'enum', value: EVENT_TYPE_STOP_ALL },
  ]);

  // At least one lap is required for most analysis platforms to accept the file.
  const laps: Lap[] = opts.laps.length
    ? [...opts.laps]
    : [{ index: 0, startTime: 0, endTime: metrics.duration, label: 'Lap 1' }];
  const lastSampleT = samples.length ? samples[samples.length - 1].t : 0;
  if (laps[laps.length - 1].endTime < lastSampleT) {
    laps.push({ index: laps.length, startTime: laps[laps.length - 1].endTime, endTime: lastSampleT, label: 'Lap' });
  }

  laps.forEach((lap, i) => {
    const inLap = slice(samples, lap.startTime, lap.endTime);
    const st = lapStats(inLap);
    const lapStartDistance = i === 0 ? 0 : (slice(samples, 0, lap.startTime).pop()?.distance ?? 0);
    const distance = inLap.length ? inLap[inLap.length - 1].distance - lapStartDistance : 0;
    const climb = climbIn(inLap);
    enc.message(LOCAL.lap, 19, [
      { num: 254, type: 'uint16', value: i },
      { num: 253, type: 'uint32', value: timeOf(lap.endTime) },
      { num: 0, type: 'enum', value: EVENT_LAP },
      { num: 1, type: 'enum', value: EVENT_TYPE_STOP },
      { num: 2, type: 'uint32', value: timeOf(lap.startTime) },
      { num: 7, type: 'uint32', value: Math.round((lap.endTime - lap.startTime) * 1000) },
      { num: 8, type: 'uint32', value: Math.round((lap.endTime - lap.startTime) * 1000) },
      { num: 9, type: 'uint32', value: Math.max(0, Math.round(distance * 100)) },
      { num: 11, type: 'uint16', value: st.calories },
      { num: 13, type: 'uint16', value: st.avgSpeed === undefined ? null : Math.round((st.avgSpeed / 3.6) * 1000) },
      { num: 14, type: 'uint16', value: st.maxSpeed === undefined ? null : Math.round((st.maxSpeed / 3.6) * 1000) },
      { num: 15, type: 'uint8', value: st.avgHr ?? null },
      { num: 16, type: 'uint8', value: st.maxHr ?? null },
      { num: 17, type: 'uint8', value: st.avgCadence ?? null },
      { num: 18, type: 'uint8', value: st.maxCadence ?? null },
      { num: 19, type: 'uint16', value: st.avgPower ?? null },
      { num: 20, type: 'uint16', value: st.maxPower ?? null },
      { num: 21, type: 'uint16', value: Math.round(climb.ascent) },
      { num: 22, type: 'uint16', value: Math.round(climb.descent) },
      { num: 25, type: 'enum', value: SPORT_CYCLING },
    ]);
  });

  const subSport = metrics.hasPosition ? SUB_SPORT_VIRTUAL_ACTIVITY : SUB_SPORT_INDOOR_CYCLING;

  enc.message(LOCAL.sport, 12, [
    { num: 0, type: 'enum', value: SPORT_CYCLING },
    { num: 1, type: 'enum', value: subSport },
    { num: 3, type: 'string', value: opts.name.slice(0, 31), size: 32 },
  ]);

  enc.message(LOCAL.session, 18, [
    { num: 254, type: 'uint16', value: 0 },
    { num: 253, type: 'uint32', value: endFit },
    { num: 0, type: 'enum', value: EVENT_SESSION },
    { num: 1, type: 'enum', value: EVENT_TYPE_STOP },
    { num: 2, type: 'uint32', value: startFit },
    { num: 3, type: 'sint32', value: semicircles(metrics.startLat) },
    { num: 4, type: 'sint32', value: semicircles(metrics.startLon) },
    { num: 5, type: 'enum', value: SPORT_CYCLING },
    { num: 6, type: 'enum', value: subSport },
    { num: 7, type: 'uint32', value: Math.round(metrics.duration * 1000) },
    { num: 8, type: 'uint32', value: Math.round(metrics.duration * 1000) },
    { num: 9, type: 'uint32', value: Math.round(metrics.distance * 100) },
    { num: 11, type: 'uint16', value: Math.round(metrics.work) },
    { num: 14, type: 'uint16', value: metrics.avgSpeed === undefined ? null : Math.round((metrics.avgSpeed / 3.6) * 1000) },
    { num: 15, type: 'uint16', value: metrics.maxSpeed === undefined ? null : Math.round((metrics.maxSpeed / 3.6) * 1000) },
    { num: 16, type: 'uint8', value: metrics.avgHr ?? null },
    { num: 17, type: 'uint8', value: metrics.maxHr ?? null },
    { num: 18, type: 'uint8', value: metrics.avgCadence ?? null },
    { num: 19, type: 'uint8', value: metrics.maxCadence ?? null },
    { num: 20, type: 'uint16', value: Math.round(metrics.avgPower) },
    { num: 21, type: 'uint16', value: Math.round(metrics.maxPower) },
    { num: 22, type: 'uint16', value: Math.round(metrics.ascent) },
    { num: 23, type: 'uint16', value: Math.round(metrics.descent) },
    { num: 25, type: 'uint16', value: 0 },
    { num: 26, type: 'uint16', value: laps.length },
    { num: 34, type: 'uint16', value: Math.round(metrics.normalisedPower) },
    { num: 35, type: 'uint16', value: Math.round(metrics.tss * 10) },
    { num: 36, type: 'uint16', value: Math.round(metrics.intensityFactor * 1000) },
  ]);

  enc.message(LOCAL.activity, 34, [
    { num: 253, type: 'uint32', value: endFit },
    { num: 0, type: 'uint32', value: Math.round(metrics.duration * 1000) },
    { num: 1, type: 'uint16', value: 1 },
    { num: 2, type: 'enum', value: 0 },
    { num: 3, type: 'enum', value: EVENT_ACTIVITY },
    { num: 4, type: 'enum', value: EVENT_TYPE_STOP },
    { num: 5, type: 'uint32', value: endFit - startedAt.getTimezoneOffset() * 60 },
  ]);

  return enc.finish();
}

export function downloadBytes(bytes: Uint8Array, filename: string, type = 'application/octet-stream'): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
