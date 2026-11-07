import type { Course } from '../activity/course';

/**
 * Climbs for the 3D view's banner, from the ride's own elevation (not the
 * drawn one), so the banner agrees with the gradient readout.
 *
 * A climb starts where the next 300 m average more than 4%, and ends where
 * the next 200 m average under 1.5%. The start is then moved up to where the
 * road actually tilts (the next 50 m over 2%), so a climb that begins after a
 * flat road is not credited with the flat.
 */

export interface Climb {
  start: number;
  /** the top: metres along the route */
  end: number;
  /** percent */
  average: number;
}

const STEP = 10;
const START_SPAN = 300;
const START_GRADE = 0.04;
const END_SPAN = 200;
const END_GRADE = 0.015;
const TILT_SPAN = 50;
const TILT_GRADE = 0.02;

export function findClimbs(course: Course): Climb[] {
  if (!course.hasElevation) return [];
  const total = course.totalDistance;
  // course.at(total) wraps to the start, so the finish is read just before it
  const ele = (d: number) => course.at(Math.max(0, Math.min(total - 1e-6, d))).ele;
  const avg = (d: number, span: number) => {
    const b = Math.min(total, d + span);
    return b - d > 1 ? (ele(b) - ele(d)) / (b - d) : 0;
  };

  const climbs: Climb[] = [];
  let start = -1;
  for (let d = 0; d < total; d += STEP) {
    if (start < 0) {
      if (d + START_SPAN <= total && avg(d, START_SPAN) > START_GRADE) {
        start = d;
        while (start < total && avg(start, TILT_SPAN) <= TILT_GRADE) start += STEP;
      }
    } else if (d >= start && avg(d, END_SPAN) < END_GRADE) {
      push(start, d);
      start = -1;
    }
  }
  if (start >= 0) push(start, total);
  return climbs;

  function push(a: number, b: number) {
    if (b - a < STEP) return;
    climbs.push({ start: a, end: b, average: ((ele(b) - ele(a)) / (b - a)) * 100 });
  }
}

/** The climb under the rider at `distance`, if any. */
export function climbAt(climbs: Climb[], distance: number): Climb | undefined {
  return climbs.find((c) => distance >= c.start && distance < c.end);
}

/** The banner's two numbers: "7%" and "1.4 km". */
export function climbBanner(climb: Climb, distance: number): { average: string; left: string } {
  const left = Math.max(0, climb.end - distance);
  return {
    average: `${Math.round(climb.average)}%`,
    left: left >= 1000 ? `${(left / 1000).toFixed(1)} km` : `${Math.round(left / 10) * 10} m`,
  };
}
