import { setupDom } from './dom-setup';
setupDom();

const { Course, gradientColor } = await import('../src/activity/course');
const { distanceForX, xForDistance, ElevationGraph, binColumns, drawElevationProfile, elevationPlot } = await import('../src/ui/elevation-graph');
const { parseGpx } = await import('../src/activity/gpx');
const { finaliseTrack, haversine } = await import('../src/activity/types');
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

/** A long, rolling route: `n` points 6 m apart, like the owner's 27k-point routes. */
function longTrack(n: number): ActivityTrack {
  const points: TrackPoint[] = [];
  for (let i = 0; i < n; i++) {
    const d = i * 6;
    points.push({ lat: 41 + d / 111320, lon: 42, ele: 300 + 150 * Math.sin(d / 4000) + 5 * Math.sin(d / 90), distance: d });
  }
  return {
    name: 'Long', source: 'gpx', points, distance: (n - 1) * 6, ascent: 0, descent: 0,
    hasPower: false, hasHr: false, hasElevation: true,
  };
}

suite('the elevation profile costs the same on a long route', () => {
  const long = new Course(longTrack(27_000));
  const size = { width: 1000, height: 220 };
  const plot = elevationPlot(size);
  const columns = binColumns(long, plot);
  check('a 27k-point route is binned into no more columns than the plot has pixels',
    columns.length > 0 && columns.length <= plot.w, `${columns.length} columns for ${plot.w} px`);
  check('the columns run from the start to the finish without a gap',
    columns[0].d0 === 0 && columns[columns.length - 1].d1 === long.totalDistance
      && columns.every((c, i) => i === 0 || c.d0 === columns[i - 1].d1));
  const short = new Course({ ...syntheticTrack(), points: syntheticTrack().points.filter((_, i) => i % 150 === 0) });
  check('a 3-point route keeps one entry per pair of points',
    short.points.length === 3 && binColumns(short, plot).length === 2, `${short.points.length} points`);

  let fills = 0;
  const ctx = new Proxy({ measureText: () => ({ width: 40 }) } as Record<string | symbol, unknown>, {
    get: (target, name) => name in target ? target[name]
      : name === 'fill' ? () => { fills++; } : () => {},
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
  drawElevationProfile(ctx, size, { course: long, ridden: long.totalDistance / 2 });
  check('one repaint fills at most one shape per gradient colour on each side of the ridden distance',
    fills > 0 && fills <= 14, `${fills} fills`);
});

suite('a very long route loads', () => {
  // 200k points spread into Math.min/max overflowed the call stack.
  const points: TrackPoint[] = [];
  for (let i = 0; i < 200_000; i++) {
    points.push({ lat: 41 + i * 6 / 111320, lon: 42, ele: 300 + 150 * Math.sin(i / 700), distance: 0, time: 1_700_000_000_000 + i * 1000, power: 150 + (i % 50) });
  }
  let track: ActivityTrack | undefined;
  let built: InstanceType<typeof Course> | undefined;
  let error = '';
  try {
    track = finaliseTrack('Very long', 'gpx', points);
    built = new Course(track);
  } catch (err) { error = (err as Error).message; }
  check('a 200,000-point track is finalised and becomes a course', built !== undefined, error);
  if (built && track) {
    // due north all the way, so the length is the great-circle distance end to end
    near('its distance is the length of the track, in m', built.totalDistance, haversine(points[0], points[points.length - 1]), 1);
    near('its lowest point', built.minEle, 150, 1);
    near('its highest point', built.maxEle, 450, 1);
    near('the track knows how long it took, in s', track.elapsed ?? 0, 199_999, 0.001);
    check('and its highest power', track.maxPower === 199);
  }
});

report();
