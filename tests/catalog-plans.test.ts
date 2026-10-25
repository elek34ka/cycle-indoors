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

suite('a flat plan', () => {
  check('builds with no errors or problems', flat.errors.length === 0 && flat.problems.length === 0,
    [...flat.errors, ...flat.problems.map((p) => p.reason)].join('; '));
  const p = flat.index.plans[0];
  check('one plan, plan:Your_First_Century', flat.index.plans.length === 1 && p.id === 'plan:Your_First_Century');
  check('titled with underscores as spaces', p.title === 'Your First Century');
  check('numbers compare as numbers, case ignored',
    p.workouts.map(stem).join() === 'TP_FirstCentury_1_7,tp_firstcentury_1_10,TP_FirstCentury_2_1,TP_FirstCentury_10_1',
    p.workouts.map(stem).join());
  check('totals: 4 workouts, 4 h', p.totals.workouts === 4 && p.totals.duration === 14400);
  const sum = p.workouts.reduce((t, id) => t + flat.index.workouts.find((w) => w.id === id)!.tss, 0);
  near('totals: TSS is the sum of its workouts\' (about 4 × 56.25)', p.totals.tss, sum, 0.05);
  near('which is about 225', p.totals.tss, 225, 0.5);
});

suite('plan workouts are ordinary workout entries', () => {
  const w = flat.index.workouts.find((x) => x.id === 'workout:plans/Your_First_Century/TP_FirstCentury_2_1');
  check('id is workout:plans/<folder>/<path>', w !== undefined);
  check('tagged with the plan title only', w?.tags.join() === 'Your First Century');
  check('knows its plan', w?.plan === 'plan:Your_First_Century');
  check('no group at the plan top level', w?.group === undefined);
  check('path includes plans/', w?.path === 'plans/Your_First_Century/TP_FirstCentury_2_1.zwo');
  check('a file to fetch, like any workout', w?.file.key.startsWith('files/') && w.file.ext === 'zwo');
  check('listed alongside standalone workouts', flat.index.workouts.length === 5);
  check('every plan id points at a workout',
    flat.index.plans.every((p) => p.workouts.every((id) => flat.index.workouts.some((x) => x.id === id))));
  check('the index validates', validateIndex(JSON.parse(JSON.stringify(flat.index))).ok);
});

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

const several = await buildCatalog([
  file('plans/Gravel/Gravel_1_1.zwo', zwo('g')),
  file('plans/4Wk_FTP_Booster/Week1/Endurance.zwo', zwo('e')),
  file('plans/Crit Crusher/8wkRaceDay_1_1.zwo', zwo('c')),
]);

suite('several plans', () => {
  check('ordered by folder, naturally', several.index.plans.map((p) => p.path).join() === '4Wk_FTP_Booster,Crit Crusher,Gravel',
    several.index.plans.map((p) => p.path).join());
  check('the spec example id', several.index.workouts.some((w) => w.id === 'workout:plans/4Wk_FTP_Booster/Week1/Endurance'));
  check('a folder name with spaces keeps them', several.index.plans[1].title === 'Crit Crusher');
});

const faults = await buildCatalog([
  file('plans/notes.json', '{"title":"old style"}'),
  file('plans/Mixed/Mixed_1.zwo', zwo('fine')),
  file('plans/Mixed/Mixed_2.zwo', '<workout_file><workout>'),
  file('plans/Mixed/readme.txt', 'hello'),
  file('plans/Broken/only.zwo', '<workout_file><workout>'),
  file('plans/Text_only/plan.json', '{}'),
  file('plans/.hidden/x.zwo', zwo('hidden')),
  file('plans/Mixed/.DS_Store', 'x'),
]);
const reasonFor = (path: string) => faults.problems.find((p) => p.path === path);

suite('problems are reported, never fatal', () => {
  check('the build does not fail', faults.errors.length === 0, faults.errors.join('; '));
  check('a loose .json in plans/ is skipped', reasonFor('plans/notes.json')?.kind === 'skipped'
    && /a plan is a folder/.test(reasonFor('plans/notes.json')!.reason));
  check('a .json inside a plan is skipped as the wrong type', reasonFor('plans/Text_only/plan.json')?.kind === 'skipped');
  check('a .txt inside a plan is skipped', reasonFor('plans/Mixed/readme.txt')?.kind === 'skipped');
  check('a broken plan workout fails alone', reasonFor('plans/Mixed/Mixed_2.zwo')?.kind === 'failed');
  check('its plan keeps the good one', faults.index.plans.find((p) => p.id === 'plan:Mixed')?.workouts.length === 1);
  check('a plan with nothing readable is left out', !faults.index.plans.some((p) => p.id === 'plan:Broken')
    && reasonFor('plans/Broken/')?.reason.includes('no workout'));
  check('so is a plan of skipped files', !faults.index.plans.some((p) => p.id === 'plan:Text_only')
    && reasonFor('plans/Text_only/') !== undefined);
  check('dot-folders and dot-files are invisible', !faults.problems.some((p) => p.path.includes('.hidden') || p.path.includes('.DS_Store'))
    && !faults.index.plans.some((p) => p.path === '.hidden'));
  check('only the readable plan is listed', faults.index.plans.map((p) => p.id).join() === 'plan:Mixed');
});

const clash = await buildCatalog([
  file('workouts/plans/Gravel/Gravel_1_1.zwo', zwo('standalone')),
  file('plans/Gravel/Gravel_1_1.zwo', zwo('in a plan')),
]);

suite('ids cannot clash silently', () => {
  check('a workouts/plans/ path that collides fails the build naming both',
    clash.errors.length === 1 && clash.errors[0].includes('workouts/plans/Gravel/Gravel_1_1.zwo')
    && clash.errors[0].includes('plans/Gravel/Gravel_1_1.zwo'), clash.errors.join('; '));
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

suite('a plan workout\'s title outside its plan', () => {
  check('gets its sub-folder in front', titleInPlan('Endurance', 'Week_12') === 'Week 12 · Endurance');
  check('nested sub-folders too', titleInPlan('Easy', 'Phase_1/Week_2') === 'Phase 1 / Week 2 · Easy');
  check('not when the title already names its week', titleInPlan('Week 1.4 - Endurance', 'Week_1') === 'Week 1.4 - Endurance'
    && titleInPlan('Week 1.4 - Endurance', 'Week1') === 'Week 1.4 - Endurance');
  check('nor when title and folder disagree on the week', titleInPlan('Week 5.6 - Endurance #3', 'Week_6') === 'Week 5.6 - Endurance #3');
  check('a word that only starts the same is not a week', titleInPlan('Weekend ride', 'Week_3') === 'Week 3 · Weekend ride');
  check('no sub-folder: unchanged', titleInPlan('Gran 1', undefined) === 'Gran 1');
});

report();
