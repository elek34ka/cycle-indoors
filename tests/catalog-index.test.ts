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

suite('a well-formed index is accepted', () => {
  const result = validateIndex(valid());
  check('accepted', result.ok);
  check('minor versions of the same major are accepted', validateIndex({ ...valid(), version: 1.4 }).ok);
});

suite('an index from a newer major version is refused', () => {
  const result = validateIndex({ ...valid(), version: 2 });
  check('refused', !result.ok);
  check('for its version', !result.ok && result.reason === 'version');
  check('saying the app needs updating', !result.ok && /newer version of the app/.test(result.message));
});

suite('damaged indexes are refused', () => {
  const cases: [string, unknown][] = [
    ['not an object', 'hello'],
    ['null', null],
    ['no version', { ...valid(), version: undefined }],
    ['workouts not a list', { ...valid(), workouts: {} }],
    ['route without a file', { ...valid(), routes: [{ id: 'route:r' }] }],
    ['workout id of the wrong kind', { ...valid(), workouts: [{ id: 'route:x', file }] }],
    ['plan without id', { ...valid(), plans: [{}] }],
    ['plan without a workout list', { ...valid(), plans: [{ id: 'plan:p' }] }],
  ];
  for (const [label, raw] of cases) {
    const result = validateIndex(raw);
    check(`${label}: refused as damaged`, !result.ok && result.reason === 'shape');
  }
});

suite('catalog URLs', () => {
  check('no catalog configured: no URL', catalogUrl('index.json', '') === undefined);
  check('joins with or without a trailing slash',
    catalogUrl('index.json', 'https://pub-x.r2.dev') === 'https://pub-x.r2.dev/index.json'
    && catalogUrl('files/a.zwo', 'https://pub-x.r2.dev/') === 'https://pub-x.r2.dev/files/a.zwo');
  check('a relative base for the local dev catalog', catalogUrl('index.json', '/catalog/') === '/catalog/index.json');
});

report();
