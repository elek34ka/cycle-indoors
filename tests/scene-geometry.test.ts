import { setupDom } from './dom-setup';
setupDom();

const { Course } = await import('../src/activity/course');
const { parseGpx } = await import('../src/activity/gpx');
const { buildGeometry, sliceLength, sliceAt, headingAt } = await import('../src/scene/geometry');
const { readFileSync } = await import('node:fs');
const { check, near, report, suite } = await import('./harness');
const { trackFromLocal, walk, eastbound } = await import('./scene-fixtures');

suite('route geometry: slices follow the route', () => {
  const sample = new Course(parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'Sample'));
  const g = buildGeometry(sample);
  const err = Math.abs(sliceLength(g) - sample.totalDistance) / sample.totalDistance;
  check('the sample loop is as long in slices as the ride measures it, within 0.5%', err < 0.005, `${(err * 100).toFixed(3)}%`);
  near('the last slice sits at the route\'s end', g.distance[g.count - 1], sample.totalDistance, 1e-6);
  check('slices are 10 m apart', g.distance[1] - g.distance[0] === 10);

  // 20.4 km of gently winding road
  const winding = new Course(trackFromLocal(walk(20400, (d) => Math.sin(d / 700) * 1.2, () => 200)));
  const gw = buildGeometry(winding);
  near('a 20.4 km route is 20.4 km in the ride', winding.totalDistance, 20400, 102);
  const errW = Math.abs(sliceLength(gw) - winding.totalDistance) / winding.totalDistance;
  check('and 20.4 km in slices, within 0.5%', errW < 0.005, `${(errW * 100).toFixed(3)}%`);

  let worst = 0;
  for (let i = 0; i < gw.count; i++) worst = Math.max(worst, Math.abs(Math.hypot(gw.tx[i], gw.tz[i]) - 1));
  check('every tangent is a unit vector', worst < 1e-9, `off by ${worst}`);
});

suite('route geometry: directions', () => {
  const g = buildGeometry(new Course(trackFromLocal(eastbound(500))));
  const mid = Math.floor(g.count / 2);
  near('eastbound: tangent points east (x)', g.tx[mid], 1, 1e-6);
  near('eastbound: tangent has no south component', g.tz[mid], 0, 1e-6);
  near('eastbound: right of travel is south (+z)', g.rz[mid], 1, 1e-6);
  near('eastbound: right has no east component', g.rx[mid], 0, 1e-6);
  near('the route starts at the local origin', Math.hypot(g.x[0], g.z[0]), 0, 1e-6);
  near('250 m along is 250 m east', g.x[sliceAt(g, 250).i], 250, 0.5);
  near('heading east is 0 rad', headingAt(g, 250), 0, 1e-6);

  const north = buildGeometry(new Course(trackFromLocal(walk(500, () => -Math.PI / 2, () => 100))));
  near('northbound: right of travel is east (+x)', north.rx[10], 1, 1e-6);
});

suite('route geometry: a route that doubles back on itself', () => {
  // 300 m east, then straight back on the same line
  const pts = [...eastbound(300), ...eastbound(300).reverse().slice(1)];
  const g = buildGeometry(new Course(trackFromLocal(pts)));
  let finite = true;
  for (let i = 0; i < g.count; i++) if (!Number.isFinite(g.tx[i]) || !Number.isFinite(g.tz[i])) finite = false;
  check('tangents stay finite where the route reverses', finite);
  near('on the way back the tangent points west', g.tx[sliceAt(g, 450).i], -1, 1e-6);
});

report();
