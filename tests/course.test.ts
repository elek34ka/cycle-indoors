import { setupDom } from './dom-setup';
setupDom();

const { Course, gradientColor } = await import('../src/activity/course');
const { distanceForX, xForDistance, ElevationGraph } = await import('../src/ui/elevation-graph');
const { parseGpx } = await import('../src/activity/gpx');
const { readFileSync } = await import('node:fs');
const { check, near, report, suite } = await import('./harness');
import type { ActivityTrack, TrackPoint } from '../src/activity/types';
import type { SessionSnapshot } from '../src/session/session';

/** 1 km flat at 100 m, 1 km climbing to 200 m (10%), 1 km back down to 100 m. */
function syntheticTrack(): ActivityTrack {
  const points: TrackPoint[] = [];
  for (let d = 0; d <= 3000; d += 10) {
    let ele = 100;
    if (d > 1000 && d <= 2000) ele = 100 + (d - 1000) * 0.1;
    else if (d > 2000) ele = 200 - (d - 2000) * 0.1;
    points.push({ lat: 50 + d / 111320, lon: 19, ele, distance: d });
  }
  return {
    name: 'Synthetic', source: 'gpx', points, distance: 3000, ascent: 0, descent: 0,
    hasPower: false, hasHr: false, hasElevation: true,
  };
}

const course = new Course(syntheticTrack());

suite('lapping the course', () => {
  const second = course.at(course.totalDistance + 1500);
  check('a second lap is counted', second.loops === 1, String(second.loops));
  near('position wraps to the same place on the lap', second.distance, 1500, 1);
  near('ascent accumulates across laps', second.totalAscent, 150, 3);
  const third = course.at(course.totalDistance * 2 + 2000);
  check('three laps in', third.loops === 2, String(third.loops));
  near('ascent after two full laps plus a climb', third.totalAscent, 3 * course.totalAscent, 2);
});

suite('the elevation cursor maps to the right place on the course', () => {
  // This is the bug from the first pass: the cursor used the full canvas width
  // while the profile was drawn inside a padded plot area, so it ran ahead.
  const plot = { x: 44, y: 20, w: 200, h: 80 };
  const total = 3000;
  near('the left edge of the plot is the start', distanceForX(44, plot, total)!, 0, 0.001);
  near('the right edge is the finish', distanceForX(244, plot, total)!, 3000, 0.001);
  near('the middle is halfway', distanceForX(144, plot, total)!, 1500, 0.001);
  check('x inside the left padding is off the course', distanceForX(20, plot, total) === undefined);
  check('x past the right edge is off the course', distanceForX(260, plot, total) === undefined);

  let worst = 0;
  for (let d = 0; d <= total; d += 37) {
    const back = distanceForX(xForDistance(d, plot, total), plot, total);
    worst = Math.max(worst, Math.abs((back ?? -1) - d));
  }
  near('drawing and hit-testing agree exactly', worst, 0, 0.0001);
});

report();
