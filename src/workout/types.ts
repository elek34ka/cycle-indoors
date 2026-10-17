export type SegmentMode = 'erg' | 'free';

/** One flattened block of the workout timeline. Ramps carry powerEnd !== powerStart. */
export interface Segment {
  index: number;
  /** seconds from workout start */
  start: number;
  duration: number;
  /** fraction of FTP (0.75 = 75% FTP); undefined in free-ride blocks */
  powerStart?: number;
  powerEnd?: number;
  cadence?: number;
  mode: SegmentMode;
  /** source element: Warmup, SteadyState, IntervalsT(on/off), FreeRide, Ramp, Cooldown */
  kind: string;
  label: string;
}

export interface TextEvent { time: number; duration: number; message: string; }

export interface Workout {
  name: string;
  author?: string;
  description?: string;
  sport?: string;
  duration: number;
  segments: Segment[];
  textEvents: TextEvent[];
  source: 'zwo' | 'fit' | 'builtin';
  /** workout-level FTP when the file specified absolute watts (FIT workouts) */
  ftpOverride?: number;
  /** non-fatal things the parser had to guess at, surfaced in the UI */
  warnings?: string[];
}

export function segmentAt(workout: Workout, elapsed: number): Segment | undefined {
  const segs = workout.segments;
  // linear scan is fine: workouts are tens of segments and this runs at 4 Hz
  for (let i = segs.length - 1; i >= 0; i--) if (elapsed >= segs[i].start) return segs[i];
  return segs[0];
}

/** Target as a fraction of FTP at a given point in time, interpolating ramps. */
export function targetRatioAt(seg: Segment, elapsed: number): number | undefined {
  if (seg.powerStart === undefined) return undefined;
  const end = seg.powerEnd ?? seg.powerStart;
  if (end === seg.powerStart || seg.duration <= 0) return seg.powerStart;
  const t = Math.min(1, Math.max(0, (elapsed - seg.start) / seg.duration));
  return seg.powerStart + (end - seg.powerStart) * t;
}

export function peakRatio(workout: Workout): number {
  let peak = 1;
  for (const s of workout.segments) {
    peak = Math.max(peak, s.powerStart ?? 0, s.powerEnd ?? 0);
  }
  return peak;
}
