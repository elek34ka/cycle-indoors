import { setupDom } from './dom-setup';
setupDom();

const { Course } = await import('../src/activity/course');
const { buildGeometry } = await import('../src/scene/geometry');
const { buildViewProfile } = await import('../src/scene/view-profile');
const { buildPasses, segmentDrawn } = await import('../src/scene/passes');
const { check, near, report, suite } = await import('./harness');
const { trackFromLocal, outAndBack } = await import('./scene-fixtures');
import type { LocalPoint } from './scene-fixtures';

function scene(points: LocalPoint[]) {
  const course = new Course(trackFromLocal(points));
  const g = buildGeometry(course);
  const vp = buildViewProfile(course, g);
  return { course, g, vp, p: buildPasses(g, vp) };
}

suite('passes: an out-and-back climb is drawn once', () => {
  const { g, p } = scene(outAndBack(1500, 8, 1));
  const topIndex = (() => { let best = 0; for (let i = 0; i < g.count; i++) if (g.x[i] > g.x[best]) best = i; return best; })();
  let descending = 0;
  let repeated = 0;
  let worstHeight = 0;
  let wrongRoot = 0;
  for (let i = topIndex + 5; i < g.count - 1; i++) {
    descending++;
    if (p.repeat[i]) {
      repeated++;
      const r = p.root[i];
      if (r >= topIndex) wrongRoot++;
      worstHeight = Math.max(worstHeight, Math.abs(p.ph[i] - p.ph[r]));
    }
  }
  check('each of them repeats a slice of the climb', wrongRoot === 0, `${wrongRoot} do not`);
  check('every descending slice from 50 m past the top on repeats the climb', repeated === descending, `${repeated}/${descending}`);
  check('and rides at the climb\'s height, within 0.9 m (10 m slices at 8%)', worstHeight <= 0.9, `${worstHeight.toFixed(2)} m`);

  // the turnaround: nothing drawn twice within 60 m of the top
  let drawnDown = 0;
  for (let i = topIndex + 1; i < g.count - 1; i++) {
    if (Math.hypot(g.x[i] - g.x[topIndex], g.z[i] - g.z[topIndex]) < 60 && segmentDrawn(p, i) && p.repeat[i] === 0 && g.x[i] < g.x[topIndex] - 30) drawnDown++;
  }
  check('the turnaround top is drawn once: no own road on the way down from 30 m below it', drawnDown === 0, `${drawnDown} slices`);
  near('the rider on the way down rides the climb\'s road, not 1 m beside it', p.pz[g.count - 20], 0, 0.01);
});

report();
