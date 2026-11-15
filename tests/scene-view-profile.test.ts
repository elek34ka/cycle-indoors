import { setupDom } from './dom-setup';
setupDom();

const { Course } = await import('../src/activity/course');
const { buildGeometry } = await import('../src/scene/geometry');
const { buildViewProfile, viewSlopeAt } = await import('../src/scene/view-profile');
const { check, near, report, suite } = await import('./harness');
const { trackFromLocal, eastbound } = await import('./scene-fixtures');

/** Drawn gradient of each slice, percent. */
function drawnGrades(heights: Float64Array, distance: Float64Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < heights.length; i++) {
    const run = distance[i + 1] - distance[i];
    if (run > 1) out.push(((heights[i + 1] - heights[i]) / run) * 100);
  }
  return out;
}

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

report();
