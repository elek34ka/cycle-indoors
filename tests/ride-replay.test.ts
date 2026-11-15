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
