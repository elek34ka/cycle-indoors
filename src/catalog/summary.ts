import { Course } from '../activity/course';
import type { ActivityTrack } from '../activity/types';
import { POWER_ZONES, zoneForRatio } from '../core/zones';
import { normalisedPower } from '../session/metrics';
import { targetRatioAt, type Workout } from '../workout/types';
import type { CompactBlock, RouteSummary, WorkoutSummary } from './types';

/** Most points an elevation thumbnail carries. */
export const PROFILE_POINTS = 200;

const round = (v: number, places: number) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/**
 * What a list needs to know about a workout without downloading it. Shared by
 * the catalog build and the browser (My library), so a file reads the same
 * wherever it is listed.
 *
 * Everything is at FTP 1: the target series is in fractions of FTP, so NP is
 * the IF directly. Free-ride blocks count towards the duration but land in no
 * zone and add no TSS — there is no target to score.
 */
export function summariseWorkout(workout: Workout): WorkoutSummary {
  const zones = POWER_ZONES.map(() => 0);
  const ergSeries: number[] = [];

  for (const seg of workout.segments) {
    if (seg.mode !== 'erg' || seg.powerStart === undefined) continue;
    // One sample per second, taken mid-second so a ramp's samples straddle
    // its ends symmetrically. A fractional tail is weighted by its length.
    const whole = Math.floor(seg.duration);
    const tail = seg.duration - whole;
    for (let i = 0; i < whole; i++) {
      const ratio = targetRatioAt(seg, seg.start + i + 0.5)!;
      zones[zoneForRatio(ratio).id - 1] += 1;
      ergSeries.push(ratio);
    }
    if (tail > 0) zones[zoneForRatio(targetRatioAt(seg, seg.start + whole + tail / 2)!).id - 1] += tail;
  }

  const ergSeconds = zones.reduce((s, v) => s + v, 0);
  const intensity = normalisedPower(ergSeries);
  const tss = (ergSeconds / 3600) * intensity ** 2 * 100;

  // Targets keep the file's full precision: rounding 1.2045 to 1.205 would
  // label the block 121% in the Library and 120% on the ride screen.
  const blocks: CompactBlock[] = workout.segments.map((seg) => (
    seg.mode === 'erg' && seg.powerStart !== undefined
      ? [round(seg.duration, 1), seg.powerStart, seg.powerEnd ?? seg.powerStart]
      : [round(seg.duration, 1), null, null]
  ));

  return {
    duration: round(workout.duration, 1),
    tss: round(tss, 1),
    if: round(intensity, 3),
    zones: zones.map((s) => round(s, 1)),
    blocks,
  };
}

/**
 * What a list needs to know about a route. Distance and ascent come from the
 * same `Course` the ride screen builds, so the list and the ride agree.
 * Throws, like `Course`, when the track has fewer than two GPS points.
 */
export function summariseRoute(track: ActivityTrack): RouteSummary {
  const course = new Course(track);
  const pts = course.points;
  const profile: [number, number][] = [];
  if (pts.length <= PROFILE_POINTS) {
    for (const p of pts) profile.push([round(p.distance, 0), round(p.ele, 1)]);
  } else {
    // Evenly spaced in distance, not in points: GPS logs bunch up on climbs.
    for (let k = 0; k < PROFILE_POINTS; k++) {
      const p = pts[course.indexForDistance((course.totalDistance * k) / (PROFILE_POINTS - 1))];
      profile.push([round(p.distance, 0), round(p.ele, 1)]);
    }
  }
  return {
    distance: round(course.totalDistance, 0),
    ascent: round(course.totalAscent, 0),
    start: [round(pts[0].lat, 6), round(pts[0].lon, 6)],
    profile,
  };
}
