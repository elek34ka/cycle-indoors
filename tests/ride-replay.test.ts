const { findEntry, replayOf, entryHash } = await import('../src/ride-log/replay');
const { check, report, suite } = await import('./harness');
type WorkoutItem = import('../src/library/entries').WorkoutItem;
type RouteItem = import('../src/library/entries').RouteItem;
type RideLogEntry = import('../src/library/db').RideLogEntry;

const summary = { duration: 600, tss: 10, if: 0.7, blocks: [] };
const workout = (key: string, extra: Partial<WorkoutItem> = {}): WorkoutItem => ({
  key, source: key.split(':')[0] as WorkoutItem['source'], id: key.split(':').slice(1).join(':'), tags: [], title: key, ...summary, ...extra,
} as WorkoutItem);
const route = (key: string, extra: Partial<RouteItem> = {}): RouteItem => ({
  key, source: key.split(':')[0] as RouteItem['source'], id: key.split(':').slice(1).join(':'), tags: [], name: key,
  distance: 1000, ascent: 10, profile: [], start: [0, 0], ...extra,
} as unknown as RouteItem);
const file = (sha256: string) => ({ key: `files/${sha256}.zwo`, sha256, size: 1, ext: 'zwo' });

const builtin = workout('builtin:quick');
const renamed = workout('catalog:workout:plans/new-name.zwo', { file: file('aaa') });
const kept = workout('mine:bbb');
const absent = workout('mine:ccc', { absent: true });
const all = [builtin, renamed, kept, absent];

suite('finding a logged workout', () => {
  check('a file\'s hash: the catalog\'s file, or My library\'s id; none for a built-in',
    entryHash(renamed) === 'aaa' && entryHash(kept) === 'bbb' && entryHash(builtin) === undefined);
  check('by its key', findEntry({ key: 'builtin:quick' }, all, true).status === 'found');
  const byHash = findEntry({ key: 'catalog:workout:plans/old-name.zwo', sha256: 'aaa' }, all, true);
  check('a renamed catalog file by its hash', byHash.status === 'found' && byHash.item === renamed);
  const mineAsCatalog = findEntry({ key: 'mine:aaa' }, all, true);
  check('an old My library key matches the same bytes in the catalog', mineAsCatalog.status === 'found' && mineAsCatalog.item === renamed);
  check('not on this device: absent', findEntry({ key: 'mine:ccc' }, all, true).status === 'absent');
  const both = findEntry({ key: 'mine:ccc', sha256: 'ccc' }, [absent, workout('catalog:workout:x.zwo', { file: file('ccc') })], true);
  check('a rideable copy wins over an absent one', both.status === 'found' && both.item.key === 'catalog:workout:x.zwo');
  check('gone: missing', findEntry({ key: 'catalog:workout:gone.zwo', sha256: 'zzz' }, all, true).status === 'missing');
  check('a title only (a file never kept): missing', findEntry({}, all, false).status === 'missing');
  check('while the catalog loads, a catalog key is pending', findEntry({ key: 'catalog:workout:gone.zwo' }, all, false).status === 'pending');
  check('and so is any hash', findEntry({ key: 'mine:zzz' }, all, false).status === 'pending');
  check('a built-in that is gone is missing without waiting', findEntry({ key: 'builtin:gone' }, all, false).status === 'missing');
});

const ride = (extra: Partial<RideLogEntry>): RideLogEntry => ({
  startedAt: 1, duration: 60, distance: 0, avgPower: 0, normalisedPower: 0, tss: 0, ascent: 0, ...extra,
});
const routes = [route('catalog:route:hills.gpx', { file: file('rrr') })];

suite('what Ride same session would load', () => {
  check('a free ride: nothing, so not ready', !replayOf(ride({}), all, routes, true).ready);
  check('a workout that is here: ready', replayOf(ride({ workout: { key: 'builtin:quick', title: 'Q' } }), all, routes, true).ready);
  const pair = replayOf(ride({ workout: { key: 'builtin:quick', title: 'Q' }, route: { key: 'catalog:route:hills.gpx', name: 'H' } }), all, routes, true);
  check('a workout and a route that are both here: ready', pair.ready && pair.route?.status === 'found');
  const half = replayOf(ride({ workout: { key: 'builtin:quick', title: 'Q' }, route: { key: 'catalog:route:gone.gpx', name: 'G' } }), all, routes, true);
  check('a route that is gone: not ready, though the workout is here', !half.ready && half.workout?.status === 'found'
    && half.route?.status === 'missing');
  check('a workout only listed (absent): not ready', !replayOf(ride({ workout: { key: 'mine:ccc', title: 'C' } }), all, routes, true).ready);
  check('still loading: not ready', !replayOf(ride({ workout: { key: 'catalog:workout:plans/new-name.zwo', title: 'N' } }), [], routes, false).ready);
});

report();
