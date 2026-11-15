import { setupDom } from './dom-setup';
setupDom();

const { positionAt, nearestDistance, gradientRuns } = await import('../src/activity/route-geometry');
const { PRESETS, routeDistances, smoothProfile } = await import('../src/activity/smoothing');
const { gradientColor } = await import('../src/activity/course');
const { parseGpx } = await import('../src/activity/gpx');
const { readFileSync } = await import('node:fs');
const { check, near, report, suite } = await import('./harness');
import type { SmoothedProfile } from '../src/activity/smoothing';

/** Metres per degree of latitude on the haversine sphere, so a point `d` metres
 *  north of the start sits exactly `d` metres along the route. */
const M_PER_DEG = (6371008.8 * Math.PI) / 180;

const sample = parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'sample');
const points = sample.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
const distances = routeDistances(points);
const total = distances[distances.length - 1];

suite('positionAt', () => {
  const first = positionAt(points, distances, 0);
  const last = positionAt(points, distances, total);
  check('0 m is the first point', first.lat === points[0].lat && first.lon === points[0].lon);
  check('the total is the last point',
    last.lat === points[points.length - 1].lat && last.lon === points[points.length - 1].lon);
  const i = Math.floor(points.length / 3);
  const mid = positionAt(points, distances, (distances[i] + distances[i + 1]) / 2);
  near('a segment\'s middle distance is its latitude midpoint', mid.lat, (points[i].lat + points[i + 1].lat) / 2, 1e-9);
  near('and its longitude midpoint', mid.lon, (points[i].lon + points[i + 1].lon) / 2, 1e-9);
  const before = positionAt(points, distances, -500);
  const after = positionAt(points, distances, total + 500);
  check('a negative distance clamps to the start', before.lat === first.lat && before.lon === first.lon);
  check('a distance past the end clamps to the finish', after.lat === last.lat && after.lon === last.lon);
});

report();
