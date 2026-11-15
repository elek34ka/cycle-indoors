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

report();
