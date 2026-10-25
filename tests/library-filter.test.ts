import { setupDom } from './dom-setup';
setupDom();

const { filterWorkouts, filterRoutes, tagsOf, isFiltered, NO_FILTERS } = await import('../src/library/filter');
const { builtinWorkouts } = await import('../src/library/entries');
const { LIBRARY } = await import('../src/workout/library');
const { workoutShapes, routeLine, workoutProfileSvg, routeProfileSvg } = await import('../src/ui/library-profile');
const { check, near, report, suite } = await import('./harness');

type W = Parameters<typeof filterWorkouts>[0][number];
type R = Parameters<typeof filterRoutes>[0][number];
const summary = { tss: 50, if: 0.8, zones: [0, 0, 0, 0, 0, 0, 0], blocks: [] };
const workout = (title: string, minutes: number, extra: Partial<W> = {}): W => ({
  key: `catalog:workout:${title}`, source: 'catalog', id: `workout:${title}`, tags: [], title,
  duration: minutes * 60, ...summary, ...extra,
});
const route = (name: string, km: number, ascent: number, extra: Partial<R> = {}): R => ({
  key: `catalog:route:${name}`, source: 'catalog', id: `route:${name}`, tags: [], name,
  distance: km * 1000, ascent, start: [0, 0], profile: [], ...extra,
});

const workouts = [
  workout('The Famous 40/20s', 60, { tags: ['vo2'], author: 'M.De Jode' }),
  workout('Russian Steps', 40, { author: 'Pav Bryan' }),
  workout('Sweet spot', 62, { source: 'builtin', key: 'builtin:ss' }),
  workout('VO2 short', 30, { tags: ['vo2', 'short'] }),
];
const routes = [route('Batumi hills', 32.2, 280, { tags: ['georgia'] }), route('Flat loop', 12, 20)];
const titles = (list: { title?: string; name?: string }[]) => list.map((x) => x.title ?? x.name).join(', ');

suite('search', () => {
  check('no filters: everything', filterWorkouts(workouts, NO_FILTERS).length === 4);
  check('"vo2" matches tags and titles, case-insensitively',
    titles(filterWorkouts(workouts, { ...NO_FILTERS, search: 'vo2' })) === 'The Famous 40/20s, VO2 short');
  check('author is searched', titles(filterWorkouts(workouts, { ...NO_FILTERS, search: 'bryan' })) === 'Russian Steps');
  check('every word must match', titles(filterWorkouts(workouts, { ...NO_FILTERS, search: 'vo2 short' })) === 'VO2 short');
  check('route names and tags', titles(filterRoutes(routes, { ...NO_FILTERS, search: 'GEORGIA' })) === 'Batumi hills');
});

suite('source, tag and ranges', () => {
  check('source', titles(filterWorkouts(workouts, { ...NO_FILTERS, source: 'builtin' })) === 'Sweet spot');
  check('tag is exact', titles(filterWorkouts(workouts, { ...NO_FILTERS, tag: 'short' })) === 'VO2 short');
  check('duration range, inclusive', titles(filterWorkouts(workouts, { ...NO_FILTERS, minMinutes: 40, maxMinutes: 60 }))
    === 'The Famous 40/20s, Russian Steps');
  check('open-ended range', filterWorkouts(workouts, { ...NO_FILTERS, minMinutes: 61 }).length === 1);
  check('distance', titles(filterRoutes(routes, { ...NO_FILTERS, minKm: 20 })) === 'Batumi hills');
  check('ascent', titles(filterRoutes(routes, { ...NO_FILTERS, maxAscent: 100 })) === 'Flat loop');
  check('tags listed once, sorted', tagsOf(workouts).join() === 'short,vo2');
});

suite('whether anything is filtered', () => {
  check('defaults are not', !isFiltered(NO_FILTERS, 'workouts') && !isFiltered(NO_FILTERS, 'routes'));
  check('a route range does not count on workouts', !isFiltered({ ...NO_FILTERS, minKm: 5 }, 'workouts')
    && isFiltered({ ...NO_FILTERS, minKm: 5 }, 'routes'));
  check('search counts everywhere', isFiltered({ ...NO_FILTERS, search: 'x' }, 'plans'));
});

suite('built-in workouts as Library entries', () => {
  const items = builtinWorkouts();
  check('one per built-in workout', items.length === LIBRARY.length);
  check('labelled built-in, keyed uniquely', items.every((w) => w.source === 'builtin' && w.key === `builtin:${w.id}`));
  check('summarised', items.every((w) => w.duration > 0 && w.blocks.length > 0));
  check('summarised once', builtinWorkouts() === items);
});

suite('workout thumbnail geometry', () => {
  const shapes = workoutShapes([[600, 0.5, 1.0], [300, 1.2, 1.2], [300, null, null]], 120, 36);
  check('one shape per block', shapes.length === 3);
  near('widths follow durations: the ramp is half the width', shapes[0].points[2][0], 60, 0.001);
  near('blocks meet end to end', shapes[1].points[0][0], shapes[0].points[3][0], 0.001);
  near('the last block ends at the right edge', shapes[2].points[2][0], 120, 0.001);
  near('120% reaches the top (peak 1.2)', shapes[1].points[1][1], 0, 0.001);
  near('50% is drawn at 5/12 of the height', 36 - shapes[0].points[1][1], 36 * 0.5 / 1.2, 0.001);
  check('a ramp rises from start to end', shapes[0].points[2][1] < shapes[0].points[1][1]);
  check('every shape stands on the bottom edge', shapes.every((s) => s.points[0][1] === 36 && s.points[3][1] === 36));
  check('coloured by the mean target\'s zone: 50→100% averages 75%, Z2', shapes[0].color === '#3f8fd8', shapes[0].color);
  check('120% is Z5', shapes[1].color === '#f08a35', shapes[1].color);
  check('free ride is grey', shapes[2].color === '#3a4656');
  check('a harder workout rescales to its own peak', workoutShapes([[60, 2.0, 2.0], [60, 1.0, 1.0]], 100, 40)[1].points[1][1] === 20);
  check('an empty workout draws nothing', workoutShapes([], 100, 40).length === 0);
  const svg = workoutProfileSvg([[600, 0.5, 1.0], [300, null, null]]);
  check('as SVG: one polygon per block', svg.querySelectorAll('polygon').length === 2);
});

suite('route thumbnail geometry', () => {
  const line = routeLine([[0, 10], [500, 60], [1000, 10]], 100, 50);
  check('spans the width', line[0][0] === 0 && line[2][0] === 100);
  check('the summit is highest on screen', line[1][1] < line[0][1] && line[0][1] === line[2][1]);
  check('stays inside the box', line.every(([, y]) => y >= 0 && y <= 50));
  check('a flat route sits mid-height', routeLine([[0, 5], [100, 5]], 100, 50).every(([, y]) => y === 25));
  const svg = routeProfileSvg([[0, 10], [500, 60], [1000, 10]]);
  check('as SVG: an area and a line', svg.querySelector('polygon') !== null && svg.querySelector('polyline') !== null);
});

suite('the done filter', () => {
  const done = new Set(['builtin:ss', 'catalog:workout:VO2 short']);
  const isDone = (key: string) => done.has(key);
  check('any: everything', filterWorkouts(workouts, NO_FILTERS, isDone).length === 4);
  check('done: only the marked ones', titles(filterWorkouts(workouts, { ...NO_FILTERS, done: 'done' }, isDone)) === 'Sweet spot, VO2 short');
  check('not done: the rest', titles(filterWorkouts(workouts, { ...NO_FILTERS, done: 'todo' }, isDone)) === 'The Famous 40/20s, Russian Steps');
  check('combines with search', titles(filterWorkouts(workouts, { ...NO_FILTERS, done: 'todo', search: 'vo2' }, isDone)) === 'The Famous 40/20s');
  check('without marks nothing is done', filterWorkouts(workouts, { ...NO_FILTERS, done: 'done' }).length === 0);
  check('counts as narrowing Workouts and Plans, not Routes',
    isFiltered({ ...NO_FILTERS, done: 'done' }, 'workouts') && isFiltered({ ...NO_FILTERS, done: 'todo' }, 'plans')
    && !isFiltered({ ...NO_FILTERS, done: 'done' }, 'routes'));
});

report();
