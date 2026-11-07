import { setupDom } from './dom-setup';
setupDom();

const { Course } = await import('../src/activity/course');
const { buildGeometry } = await import('../src/scene/geometry');
const { buildViewProfile, viewSlopeAt } = await import('../src/scene/view-profile');
const { check, near, report, suite } = await import('./harness');
const { trackFromLocal, eastbound, rng } = await import('./scene-fixtures');

/** Drawn gradient of each slice, percent. */
function drawnGrades(heights: Float64Array, distance: Float64Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < heights.length; i++) {
    const run = distance[i + 1] - distance[i];
    if (run > 1) out.push(((heights[i + 1] - heights[i]) / run) * 100);
  }
  return out;
}

suite('view profile: a spike is not drawn', () => {
  // flat road at 100 m, one GPS point 15 m high at 1 km
  const course = new Course(trackFromLocal(eastbound(2000, (d) => (Math.abs(d - 1000) < 1e-6 ? 115 : 100))));
  const before = [500, 990, 1000, 1010, 1500].map((d) => course.at(d));
  const g = buildGeometry(course);
  const vp = buildViewProfile(course, g);
  let worst = 0;
  for (let i = 0; i < g.count; i++) worst = Math.max(worst, Math.abs(vp.heights[i] - 100));
  check('the drawn road stays flat through the spike, within 0.5 m', worst < 0.5, `off by ${worst.toFixed(2)} m`);
  const after = [500, 990, 1000, 1010, 1500].map((d) => course.at(d));
  check('the ride\'s gradient and elevation are exactly as before', JSON.stringify(before) === JSON.stringify(after));
  check('the ride still feels the spike, so readouts differ from the drawing', Math.abs(course.at(985).gradient) > 0.5,
    `ride gradient ${course.at(985).gradient.toFixed(2)}%`);
});

suite('view profile: a 28% ramp is drawn at 20% or less', () => {
  const ramp = (d: number) => (d < 1000 ? 100 : d < 1040 ? 100 + (d - 1000) * 0.28 : 111.2);
  const course = new Course(trackFromLocal(eastbound(2500, ramp)));
  const g = buildGeometry(course);
  const vp = buildViewProfile(course, g);
  const grades = drawnGrades(vp.heights, g.distance);
  const steepest = Math.max(...grades.map(Math.abs));
  check('no drawn slice is steeper than 20%', steepest <= 20 + 1e-6, `${steepest.toFixed(2)}%`);
  check('but the climb is still drawn as a climb', steepest > 5, `${steepest.toFixed(2)}%`);
  let change = 0;
  for (let i = 1; i < grades.length; i++) change = Math.max(change, Math.abs(grades[i] - grades[i - 1]));
  check('drawn gradient changes by at most 2 points per 10 m', change <= 2 + 1e-6, `${change.toFixed(3)}`);
  near('the road above the ramp is at the ramp\'s top', vp.heights[g.count - 1], 111.2, 0.6);
  near('drawn slope at 1 km is a climb, read as rise over run', viewSlopeAt(g, vp, 1030) * 100, Math.max(...grades), 6);
});

suite('view profile: a short, deep dip is drawn nearly as deep', () => {
  // the shape of a real route's U-turn under a road: 20 m down in 70 m,
  // 150 m along the bottom, 20 m back up in 70 m
  const dip = (d: number) => {
    if (d < 1000) return 200;
    if (d < 1070) return 200 - ((d - 1000) / 70) * 20;
    if (d < 1220) return 180;
    if (d < 1290) return 180 + ((d - 1220) / 70) * 20;
    return 200;
  };
  const course = new Course(trackFromLocal(eastbound(2500, dip)));
  const g = buildGeometry(course);
  const vp = buildViewProfile(course, g);
  let worst = 0;
  for (let i = 0; i < g.count; i++) {
    const d = Math.min(g.distance[i], course.totalDistance - 1e-6);
    worst = Math.max(worst, Math.abs(vp.heights[i] - course.at(d).ele));
  }
  check('drawn height stays within 10 m of the route through the dip', worst <= 10, `${worst.toFixed(2)} m`);
  check('the bottom is drawn at least 12 m below the road around it', 200 - Math.min(...vp.heights) >= 12,
    `${(200 - Math.min(...vp.heights)).toFixed(2)} m`);
  const grades = drawnGrades(vp.heights, g.distance);
  let change = 0;
  for (let i = 1; i < grades.length; i++) change = Math.max(change, Math.abs(grades[i] - grades[i - 1]));
  check('while drawn gradient stays within ±20%', Math.max(...grades.map(Math.abs)) <= 20 + 1e-6);
  check('and changes by at most 2 points per 10 m', change <= 2 + 1e-6, `${change.toFixed(3)}`);
});

suite('view profile: 200 random noisy routes', () => {
  const rand = rng(20261107);
  let worstHeight = 0;
  let worstChange = 0;
  let worstGrade = 0;
  for (let n = 0; n < 200; n++) {
    // grade changes every 100–600 m, within ±15%, so no stretch exceeds 20%
    const segments: { until: number; grade: number }[] = [];
    let at = 0;
    while (at < 5000) { at += 100 + rand() * 500; segments.push({ until: at, grade: (rand() * 2 - 1) * 15 }); }
    const heights: number[] = [];
    let h = 200;
    for (let d = 0; d <= 5000; d += 5) {
      const seg = segments.find((s) => d < s.until) ?? segments[segments.length - 1];
      h += (seg.grade / 100) * 5;
      heights.push(h);
    }
    const noisy = heights.map((v) => v + (rand() * 2 - 1) + (rand() < 0.01 ? (rand() * 2 - 1) * 20 : 0));
    const course = new Course(trackFromLocal(eastbound(5000, (d) => noisy[Math.round(d / 5)])));
    const g = buildGeometry(course);
    const vp = buildViewProfile(course, g);
    // course.at(total) wraps to the start (a course is ridden in laps), so the
    // finish is read just before it
    for (let i = 0; i < g.count; i++) {
      const d = Math.min(g.distance[i], course.totalDistance - 1e-6);
      worstHeight = Math.max(worstHeight, Math.abs(vp.heights[i] - course.at(d).ele));
    }
    const grades = drawnGrades(vp.heights, g.distance);
    for (let i = 0; i < grades.length; i++) {
      worstGrade = Math.max(worstGrade, Math.abs(grades[i]));
      if (i > 0) worstChange = Math.max(worstChange, Math.abs(grades[i] - grades[i - 1]));
    }
  }
  check('drawn height stays within 10 m of the route\'s elevation', worstHeight <= 10, `${worstHeight.toFixed(2)} m`);
  check('drawn gradient stays within ±20%', worstGrade <= 20 + 1e-6, `${worstGrade.toFixed(2)}%`);
  check('drawn gradient changes by at most 2 points per 10 m', worstChange <= 2 + 1e-6, `${worstChange.toFixed(3)}`);
});

suite('view profile: a route without elevation is flat', () => {
  const course = new Course(trackFromLocal(eastbound(800, () => undefined)));
  const g = buildGeometry(course);
  const vp = buildViewProfile(course, g);
  check('it is marked as having no elevation', vp.hasElevation === false);
  check('every drawn height is 0', vp.heights.every((v) => v === 0));
});

report();
