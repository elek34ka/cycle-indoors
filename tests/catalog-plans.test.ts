import { setupDom } from './dom-setup';
setupDom();

const { buildCatalog, naturalCompare, titleSequence } = await import('../src/catalog/build');
const { displayName, titleInPlan } = await import('../src/catalog/names');
const { validateIndex } = await import('../src/catalog/types');
const { check, near, report, suite } = await import('./harness');

const enc = (s: string) => new TextEncoder().encode(s);
const file = (path: string, text: string) => ({ path, bytes: enc(text) });
const zwo = (name: string, seconds = 3600, power = 0.75) =>
  `<workout_file><name>${name}</name><workout><SteadyState Duration="${seconds}" Power="${power}"/></workout></workout_file>`;
const stem = (id: string) => id.split('/').pop();

// Shaped like content/plans/Your_First_Century: flat, numbers in the names.
const flat = await buildCatalog([
  file('plans/Your_First_Century/TP_FirstCentury_2_1.zwo', zwo('Two one')),
  file('plans/Your_First_Century/TP_FirstCentury_10_1.zwo', zwo('Ten one')),
  file('plans/Your_First_Century/TP_FirstCentury_1_7.zwo', zwo('One seven')),
  file('plans/Your_First_Century/tp_firstcentury_1_10.zwo', zwo('One ten')),
  file('workouts/vo2/short.zwo', zwo('Short', 600, 1.1)),
]);

// Shaped like GCN_Zero_to_Hero_Plan and Letape: sub-folders.
const nested = await buildCatalog([
  file('plans/GCN_Zero_to_Hero_Plan/Week_10/a.zwo', zwo('W10 a')),
  file('plans/GCN_Zero_to_Hero_Plan/Week_2/b.zwo', zwo('W2 b')),
  file('plans/GCN_Zero_to_Hero_Plan/Week_2/a.zwo', zwo('W2 a')),
  file('plans/GCN_Zero_to_Hero_Plan/Week_2/extra/z.zwo', zwo('W2 extra z')),
  file('plans/GCN_Zero_to_Hero_Plan/Intro.zwo', zwo('Intro')),
  file('plans/GCN_Zero_to_Hero_Plan/Zz_last_name.zwo', zwo('Top-level, late name')),
]);

suite('a plan with sub-folders', () => {
  const p = nested.index.plans[0];
  const titles = p.workouts.map((id) => nested.index.workouts.find((w) => w.id === id)!.title);
  check('top-level files first, then Week_2, then Week_10',
    titles.join(' | ') === 'Intro | Top-level, late name | W2 a | W2 b | W2 extra z | W10 a', titles.join(' | '));
  const w = nested.index.workouts.find((x) => x.id === 'workout:plans/GCN_Zero_to_Hero_Plan/Week_2/b');
  check('a sub-folder is the group, not a tag', w?.group === 'Week_2' && w.tags.join() === 'GCN Zero to Hero Plan');
  check('nested sub-folders join into one group',
    nested.index.workouts.find((x) => x.title === 'W2 extra z')?.group === 'Week_2/extra');
  check('group names display with spaces', displayName('Week_2') === 'Week 2' && displayName('Week_2/extra') === 'Week 2 / extra');
});

suite('natural order', () => {
  const sorted = ['Week_10', 'week_2', 'Week_1', 'Week_2'].sort(naturalCompare);
  check('Week_1, Week_2, week_2, Week_10 — and deterministic on ties', sorted.join() === 'Week_1,Week_2,week_2,Week_10', sorted.join());
  check('tri_1_3a after tri_1_3', ['tri_1_3a', 'tri_1_4', 'tri_1_3'].sort(naturalCompare).join() === 'tri_1_3,tri_1_3a,tri_1_4');
});

// Shaped like British_Cycling_eRacing_Championship: the file names carry no
// order, the titles do.
const numbered = await buildCatalog([
  file('plans/BC/Week_1/1_min_Intervals.zwo', zwo('Week 1.3 -  1 Min Intervals')),
  file('plans/BC/Week_1/3X10_mins.zwo', zwo('Week 1.1 -  3x10 Min Threshold')),
  file('plans/BC/Week_1/Free_Ride_Week_1.zwo', zwo('Week 1.4 - Free Ride')),
  file('plans/BC/Week_1/VO2_Ramp.zwo', zwo('Week 1.2 -  VO2 Ramp')),
  file('plans/BC/Week_2/2X20.zwo', zwo('Week 2.1 -  2x20 Min')),
  file('plans/BC/Week_10/a.zwo', zwo('Week 10.1 - Taper')),
]);
// Shaped like GranFondo: plain titles, ordered file names.
const plain = await buildCatalog([
  file('plans/GF/Gran_1_1.zwo', zwo('Welcome Workout')),
  file('plans/GF/Gran_1_2.zwo', zwo('Introductory Intervals')),
  file('plans/GF/Gran_1_3.zwo', zwo('Endurance Free Ride')),
]);
// Only some titles numbered: no order to trust in them.
const mixed = await buildCatalog([
  file('plans/MX/a_1.zwo', zwo('Week 1.2 - B')),
  file('plans/MX/a_2.zwo', zwo('Rest spin')),
  file('plans/MX/a_3.zwo', zwo('Week 1.1 - A')),
]);
const titlesOf = (b: typeof numbered) => b.index.plans[0].workouts.map((id) => b.index.workouts.find((w) => w.id === id)!.title);

suite('numbered titles set the order', () => {
  check('the spec case: Week 1.1, 1.2, 1.3, 1.4, then Week 2, then Week 10',
    titlesOf(numbered).map((t) => t.slice(0, 9)).join(',') === 'Week 1.1 ,Week 1.2 ,Week 1.3 ,Week 1.4 ,Week 2.1 ,Week 10.1',
    titlesOf(numbered).join(' | '));
  check('plain titles keep file-name order', titlesOf(plain).join(',') === 'Welcome Workout,Introductory Intervals,Endurance Free Ride',
    titlesOf(plain).join(' | '));
  check('half-numbered plans keep file-name order', titlesOf(mixed).join(',') === 'Week 1.2 - B,Rest spin,Week 1.1 - A',
    titlesOf(mixed).join(' | '));
  check('sequence numbers read', JSON.stringify(titleSequence('Week 1.3 -  1 Min Intervals')) === '[1,3]'
    && JSON.stringify(titleSequence('Phase 2.10 - x')) === '[2,10]' && JSON.stringify(titleSequence('1.3 Tempo')) === '[1,3]');
  check('and not read where there are none', titleSequence('Day 2 - Bike') === undefined
    && titleSequence('Week 1 - Initial Testing.2 - FTP Test') === undefined && titleSequence('5x6 Sweet Spot') === undefined);
});

report();
