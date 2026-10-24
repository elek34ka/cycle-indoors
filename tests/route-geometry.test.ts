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

suite('nearestDistance', () => {
  // The sample is a loop, so a distance near either end has a twin at the
  // other; stay clear of the ends and check the round trip everywhere else.
  let worst = 0;
  for (let k = 1; k <= 50; k++) {
    const d = (total * k) / 52;
    const p = positionAt(points, distances, d);
    worst = Math.max(worst, Math.abs(nearestDistance(points, distances, p.lat, p.lon) - d));
  }
  check('a point on the route maps back to its own distance within 1 m, at 50 places', worst <= 1, `worst ${worst} m`);

  // a straight 1 km road due north, sampled every 100 m
  const road = Array.from({ length: 11 }, (_, k) => ({ lat: 50 + (k * 100) / M_PER_DEG, lon: 19 }));
  const roadDistances = routeDistances(road);
  const eastward = 20 / (M_PER_DEG * Math.cos((50.0031 * Math.PI) / 180));
  near('a point 20 m off the road gives the foot\'s distance',
    nearestDistance(road, roadDistances, 50 + 345 / M_PER_DEG, 19 + eastward), 345, 1);
  near('a point beyond the end clamps to the end',
    nearestDistance(road, roadDistances, 50 + 1300 / M_PER_DEG, 19), 1000, 1e-6);
  near('a point before the start clamps to the start',
    nearestDistance(road, roadDistances, 50 - 300 / M_PER_DEG, 19), 0, 1e-6);
});

suite('gradientRuns', () => {
  // flat 300 m, 8.5% for 300 m, flat 300 m, points every 10 m
  const road = Array.from({ length: 91 }, (_, k) => ({ lat: 50 + (k * 10) / M_PER_DEG, lon: 19 }));
  const roadDistances = routeDistances(road);
  const grade = Array.from({ length: 90 }, (_, k) => (k >= 30 && k < 60 ? 8.5 : 0));
  const profile = { step: 10, smoothedGradient: grade } as SmoothedProfile;
  const runs = gradientRuns(road, roadDistances, profile);
  check('flat, climb, flat is three runs', runs.length === 3, String(runs.length));
  check('coloured flat, 7–10%, flat',
    runs[0]?.color === gradientColor(0) && runs[1]?.color === gradientColor(8.5) && runs[2]?.color === gradientColor(0));
  check('the climb is not coloured like the flat', gradientColor(8.5) !== gradientColor(0));

  const smoothed = smoothProfile(sample, PRESETS.medium);
  const real = gradientRuns(points, distances, smoothed);
  const joined = real.every((run, k) => k === 0
    || (run.latlngs[0][0] === real[k - 1].latlngs.at(-1)![0] && run.latlngs[0][1] === real[k - 1].latlngs.at(-1)![1]));
  check('every run starts where the previous one ended', joined);
  const count = real.reduce((n, run) => n + run.latlngs.length, 0);
  check('no point is lost or doubled beyond the shared joins', count === points.length + real.length - 1,
    `${count} vs ${points.length + real.length - 1}`);
  check('far fewer runs than points', real.length < points.length * 0.1, `${real.length} runs, ${points.length} points`);

  const strong = gradientRuns(points, distances, smoothProfile(sample, PRESETS.strong));
  const colours = (rs: typeof real) => rs.map((r) => `${r.color}:${r.latlngs.length}`).join(',');
  check('Strong colours the route differently from Medium', colours(strong) !== colours(real));
});

report();
