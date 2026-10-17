import { setupDom } from './dom-setup';
setupDom();

const { Course, gradientColor } = await import('../src/activity/course');
const { distanceForX, xForDistance } = await import('../src/ui/elevation-graph');
const { parseGpx } = await import('../src/activity/gpx');
const { readFileSync } = await import('node:fs');
const { check, near, report, suite } = await import('./harness');
import type { ActivityTrack, TrackPoint } from '../src/activity/types';

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

suite('course geometry', () => {
  near('total distance', course.totalDistance, 3000, 1);
  near('total ascent', course.totalAscent, 100, 2);
  near('total descent', course.totalDescent, 100, 4);
  near('lowest point', course.minEle, 100, 1);
  near('highest point', course.maxEle, 200, 2);

  near('the flat section reads as flat', course.at(500).gradient, 0, 0.3);
  near('the climb reads as 10%', course.at(1500).gradient, 10, 0.3);
  near('the descent reads as -10%', course.at(2500).gradient, -10, 0.3);
  near('elevation halfway up the climb', course.at(1500).ele, 150, 1.5);
  near('ascent halfway up the climb', course.at(1500).ascent, 50, 2);
  near('ascent at the top', course.at(2000).ascent, 100, 2);
  near('ascent does not grow on the descent', course.at(2999).ascent, 100, 2);
  check('the very end of the course wraps to the start of the next lap',
    course.at(3000).loops === 1 && course.at(3000).distance === 0);
});

suite('lapping the course', () => {
  const second = course.at(course.totalDistance + 1500);
  check('a second lap is counted', second.loops === 1, String(second.loops));
  near('position wraps to the same place on the lap', second.distance, 1500, 1);
  near('ascent accumulates across laps', second.totalAscent, 150, 3);
  const third = course.at(course.totalDistance * 2 + 2000);
  check('three laps in', third.loops === 2, String(third.loops));
  near('ascent after two full laps plus a climb', third.totalAscent, 3 * course.totalAscent, 2);
});

suite('gradient colours', () => {
  check('a descent is blue', gradientColor(-6) === '#5bc8f5');
  check('flat is grey', gradientColor(0) === '#7a8694');
  check('a gentle rise is green', gradientColor(3) === '#3fc07a');
  check('a hard climb is orange', gradientColor(8) === '#f08a35');
  check('a wall is magenta', gradientColor(20) === '#b02a7a');
  check('the scale is monotonic in distinct colours',
    new Set([-10, -1, 2, 5, 8, 12, 20].map(gradientColor)).size === 7);
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

suite('the sample route becomes a rideable course', () => {
  const track = parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'sample');
  const loop = new Course(track);
  check('it has elevation', loop.hasElevation);
  check('ascent is in a sane range for a 20 km loop', loop.totalAscent > 100 && loop.totalAscent < 900,
    `${Math.round(loop.totalAscent)} m`);
  check('gradients stay inside the clamp',
    loop.points.every((p) => p.gradient >= -25 && p.gradient <= 25));
  check('gradients are not all zero', loop.points.some((p) => Math.abs(p.gradient) > 1));
  check('ascent never decreases along the course',
    loop.points.every((p, i, all) => i === 0 || p.ascent >= all[i - 1].ascent));
  check('distance lookup is monotonic',
    [0, 1000, 5000, 12000, loop.totalDistance].every((d, i, all) =>
      i === 0 || loop.indexForDistance(d) >= loop.indexForDistance(all[i - 1])));
});

report();
