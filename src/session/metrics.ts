import { HR_ZONES, POWER_ZONES, zoneForHr, zoneForRatio, type RiderZones } from '../core/zones';

export interface Sample {
  /** seconds of elapsed ride time */
  t: number;
  power: number;
  targetPower: number;
  heartRate?: number;
  cadence?: number;
  /** km/h */
  speed?: number;
  /** cumulative metres */
  distance: number;
  /** position on the loaded route, when there is one */
  lat?: number;
  lon?: number;
  /** metres above sea level */
  altitude?: number;
}

/** A per-second altitude change larger than this is a lap wrap or a spike, not
 *  a climb — counting it would invent hundreds of metres of elevation gain. */
const MAX_ALTITUDE_STEP = 8;

export interface ZoneTime { zone: number; label: string; color: string; seconds: number; }

export interface RideMetrics {
  duration: number;
  avgPower: number;
  maxPower: number;
  normalisedPower: number;
  intensityFactor: number;
  tss: number;
  work: number;        // kJ
  avgHr?: number;
  maxHr?: number;
  avgCadence?: number;
  maxCadence?: number;
  avgSpeed?: number;
  maxSpeed?: number;
  distance: number;
  /** metres climbed / dropped along the recorded track */
  ascent: number;
  descent: number;
  hasPosition: boolean;
  startLat?: number;
  startLon?: number;
  zones: ZoneTime[];
  /** time in each heart-rate zone, counting only seconds with a reading; all zero without a max HR */
  hrZones: ZoneTime[];
  /** how closely the ride tracked the workout target, 0-100 (undefined for free rides) */
  compliance?: number;
}

function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : undefined;
}

/** 30-second rolling-average power raised to the 4th power — Coggan's NP. */
export function normalisedPower(powers: number[], window = 30): number {
  if (powers.length === 0) return 0;
  if (powers.length < window) return mean(powers) ?? 0;
  let sum = 0;
  for (let i = 0; i < window; i++) sum += powers[i];
  const quartics: number[] = [(sum / window) ** 4];
  for (let i = window; i < powers.length; i++) {
    sum += powers[i] - powers[i - window];
    quartics.push((sum / window) ** 4);
  }
  return ((quartics.reduce((s, v) => s + v, 0) / quartics.length)) ** 0.25;
}

/** Time in zones is measured against `zones`, the rider's own; the standard zones without them. */
export function computeMetrics(
  samples: Sample[],
  ftp: number,
  hrMax?: number,
  zones: RiderZones = { power: POWER_ZONES, hr: HR_ZONES },
): RideMetrics {
  const powers = samples.map((s) => s.power);
  const hrs = samples.map((s) => s.heartRate).filter((v): v is number => v !== undefined && v > 0);
  const cads = samples.map((s) => s.cadence).filter((v): v is number => v !== undefined);
  const speeds = samples.map((s) => s.speed).filter((v): v is number => v !== undefined);

  const duration = samples.length;
  const avgPower = mean(powers) ?? 0;
  const np = normalisedPower(powers);
  const intensityFactor = ftp > 0 ? np / ftp : 0;
  const tss = ftp > 0 ? (duration * np * intensityFactor) / (ftp * 3600) * 100 : 0;

  const seconds = new Map<number, number>();
  for (const s of samples) {
    const z = zoneForRatio(ftp > 0 ? s.power / ftp : 0, zones.power);
    seconds.set(z.id, (seconds.get(z.id) ?? 0) + 1);
  }

  const hrSeconds = new Map<number, number>();
  if (hrMax && hrMax > 0) {
    for (const s of samples) {
      if (!(s.heartRate && s.heartRate > 0)) continue;
      const z = zoneForHr(s.heartRate, hrMax, zones.hr);
      hrSeconds.set(z.id, (hrSeconds.get(z.id) ?? 0) + 1);
    }
  }

  let ascent = 0;
  let descent = 0;
  let previousAltitude: number | undefined;
  for (const s of samples) {
    if (s.altitude === undefined) continue;
    if (previousAltitude !== undefined) {
      const delta = s.altitude - previousAltitude;
      if (Math.abs(delta) <= MAX_ALTITUDE_STEP) {
        if (delta > 0) ascent += delta; else descent -= delta;
      }
    }
    previousAltitude = s.altitude;
  }

  const firstFix = samples.find((s) => s.lat !== undefined && s.lon !== undefined);

  const targeted = samples.filter((s) => s.targetPower > 0);
  const compliance = targeted.length
    ? Math.max(0, 100 - (mean(targeted.map((s) => Math.abs(s.power - s.targetPower) / s.targetPower * 100)) ?? 0))
    : undefined;

  return {
    duration,
    avgPower,
    maxPower: powers.length ? Math.max(...powers) : 0,
    normalisedPower: np,
    intensityFactor,
    tss,
    work: powers.reduce((s, v) => s + v, 0) / 1000,
    avgHr: mean(hrs),
    maxHr: hrs.length ? Math.max(...hrs) : undefined,
    avgCadence: mean(cads),
    maxCadence: cads.length ? Math.max(...cads) : undefined,
    avgSpeed: mean(speeds),
    maxSpeed: speeds.length ? Math.max(...speeds) : undefined,
    distance: samples.length ? samples[samples.length - 1].distance : 0,
    ascent,
    descent,
    hasPosition: firstFix !== undefined,
    startLat: firstFix?.lat,
    startLon: firstFix?.lon,
    zones: zones.power.map((z) => ({
      zone: z.id, label: z.label, color: z.color, seconds: seconds.get(z.id) ?? 0,
    })),
    hrZones: zones.hr.map((z) => ({
      zone: z.id, label: z.label, color: z.color, seconds: hrSeconds.get(z.id) ?? 0,
    })),
    compliance,
  };
}
