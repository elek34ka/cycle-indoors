import { setupDom } from './dom-setup';
setupDom();

const { Course } = await import('../src/activity/course');
const { findClimbs, climbAt, climbBanner } = await import('../src/scene/climbs');
const { check, near, report, suite } = await import('./harness');
const { trackFromLocal, eastbound } = await import('./scene-fixtures');

/** Elevation from a list of [length, grade%] stretches, starting at 100 m. */
function profile(stretches: [number, number][]): (d: number) => number {
  return (d) => {
    let h = 100;
    let at = 0;
    for (const [len, grade] of stretches) {
      const run = Math.min(len, Math.max(0, d - at));
      h += (run * grade) / 100;
      at += len;
    }
    return h;
  };
}

const course = (stretches: [number, number][]) => {
  const total = stretches.reduce((s, [l]) => s + l, 0);
  return new Course(trackFromLocal(eastbound(total, profile(stretches))));
};

suite('climbs: a 2 km climb at 7%', () => {
  const c = course([[1000, 0], [2000, 7], [1000, 0]]);
  const climbs = findClimbs(c);
  check('is one climb', climbs.length === 1, `${climbs.length}`);
  near('it starts where the road tilts, within 60 m', climbs[0].start, 1000, 60);
  near('and ends at the top, within 60 m', climbs[0].end, 3000, 60);
  const at = climbAt(climbs, 1600);
  check('600 m in, the rider is on it', at !== undefined);
  const banner = climbBanner(at!, 1600);
  check('the banner reads 7%', banner.average === '7%', banner.average);
  check('and 1.4 km left', banner.left === '1.4 km', banner.left);
  check('the flat after the top is not a climb', climbAt(climbs, 3500) === undefined);
  check('near the top it counts in metres', climbBanner(at!, 2700).left.endsWith(' m'), climbBanner(at!, 2700).left);
});

suite('climbs: flat road', () => {
  check('gives no climbs', findClimbs(course([[5000, 0]])).length === 0);
  check('nor does a gentle 2% drag', findClimbs(course([[1000, 0], [2000, 2], [1000, 0]])).length === 0);
  check('nor a route without elevation', findClimbs(new Course(trackFromLocal(eastbound(3000, () => undefined)))).length === 0);
});

suite('climbs: a climb split by a dip', () => {
  // 1 km at 7%, 100 m down at 6% (the next 200 m average under 1.5%), 1 km at 7%
  const c = course([[500, 0], [1000, 7], [100, -6], [1000, 7], [500, 0]]);
  const climbs = findClimbs(c);
  check('counts as two climbs', climbs.length === 2, `${climbs.length}: ${JSON.stringify(climbs)}`);
  if (climbs.length === 2) {
    check('the first ends before the dip', climbs[0].end <= 1500 + 20, `${climbs[0].end}`);
    check('the second starts after it', climbs[1].start >= 1600 - 60, `${climbs[1].start}`);
  }
});

report();
