import type { RideLogEntry } from '../library/db';
import type { LoadedEntry } from '../library/loaded';
import type { RideMetrics } from '../session/metrics';

/** A ride shorter than this is a stray Start/Finish, not a ride worth logging. */
export const MIN_LOGGED_SECONDS = 60;

export interface FinishedRide {
  startedAt: Date;
  metrics: RideMetrics;
  /** the workout loaded at Finish: its Library entry when it has one */
  workout?: { title: string; entry?: LoadedEntry };
  route?: { name: string; entry?: LoadedEntry };
}

const entryRef = (entry: LoadedEntry | undefined) => ({
  ...(entry ? { key: entry.key } : {}),
  ...(entry?.sha256 ? { sha256: entry.sha256 } : {}),
});

/**
 * The ride log's record of a finished ride: its headline numbers and what was
 * ridden, never samples, a track or a file, so a profile backup of years of
 * rides stays small. Undefined for a ride too short to log.
 */
export function rideLogEntry(ride: FinishedRide): RideLogEntry | undefined {
  const m = ride.metrics;
  if (!(m.duration >= MIN_LOGGED_SECONDS)) return undefined;
  return {
    startedAt: ride.startedAt.getTime(),
    duration: Math.round(m.duration),
    distance: Math.round(m.distance),
    avgPower: Math.round(m.avgPower),
    normalisedPower: Math.round(m.normalisedPower),
    tss: Math.round(m.tss * 10) / 10,
    ...(m.avgHr !== undefined && Number.isFinite(m.avgHr) ? { avgHr: Math.round(m.avgHr) } : {}),
    ascent: Math.round(m.ascent),
    ...(ride.workout ? { workout: { title: ride.workout.title, ...entryRef(ride.workout.entry) } } : {}),
    ...(ride.route ? { route: { name: ride.route.name, ...entryRef(ride.route.entry) } } : {}),
  };
}
