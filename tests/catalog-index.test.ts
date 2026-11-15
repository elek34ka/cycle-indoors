const { validateIndex, INDEX_VERSION } = await import('../src/catalog/types');
const { catalogUrl } = await import('../src/catalog/config');
const { check, report, suite } = await import('./harness');

const file = { key: 'files/abc.zwo', sha256: 'abc', size: 10, ext: 'zwo' };
const valid = () => ({
  version: INDEX_VERSION,
  builtAt: '2026-10-25T10:00:00.000Z',
  workouts: [{ id: 'workout:x', path: 'x.zwo', tags: [], title: 'X', file }],
  routes: [{ id: 'route:r', path: 'r.gpx', tags: [], name: 'R', file: { ...file, ext: 'gpx' } }],
  plans: [{ id: 'plan:p', path: 'p', title: 'P', workouts: [], totals: { workouts: 0, duration: 0, tss: 0 } }],
});

suite('an index from a newer major version is refused', () => {
  const result = validateIndex({ ...valid(), version: 2 });
  check('refused', !result.ok);
  check('for its version', !result.ok && result.reason === 'version');
  check('saying the app needs updating', !result.ok && /newer version of the app/.test(result.message));
});

report();
