const { CatalogClient } = await import('../src/catalog/client');
const { sha256 } = await import('../src/catalog/hash');
const { check, report, suite } = await import('./harness');

const BASE = 'https://pub-test.r2.dev';
const bytes = new TextEncoder().encode('<workout_file/>');
const hash = await sha256(bytes);
const file = { key: `files/${hash}.zwo`, sha256: hash, size: bytes.byteLength, ext: 'zwo' };
const index = {
  version: 1, builtAt: '2026-10-25T10:00:00.000Z',
  workouts: [{ id: 'workout:a', path: 'a.zwo', tags: [], title: 'A', file }], routes: [], plans: [],
};

/** A stand-in fetch serving a map of URL → response, recording each request. */
function stand(responses: Record<string, () => Response | Promise<Response>>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const make = responses[url];
    if (!make) return new Response('missing', { status: 404 });
    return make();
  };
  return { calls, fetchFn };
}

const json = (v: unknown) => () => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });

const ok = stand({ [`${BASE}/index.json`]: json(index), [`${BASE}/${file.key}`]: () => new Response(bytes) });
const okClient = new CatalogClient(BASE, ok.fetchFn);
const first = await okClient.loadIndex();
const second = await okClient.loadIndex();
const callsAfterTwo = ok.calls.length;
await okClient.loadIndex(true);
const fetched = await okClient.fetchFile(file);

suite('a reachable catalog', () => {
  check('index loads', first.ok && first.index.workouts.length === 1);
  check('revalidated with the bucket, not served blindly from cache', ok.calls[0].init?.cache === 'no-cache');
  check('kept once loaded: the second call does not fetch', second === first && callsAfterTwo === 1, String(callsAfterTwo));
  check('a fresh load asks again', ok.calls.filter((c) => c.url.endsWith('index.json')).length === 2);
  check('a file downloads with its hash checked', new TextDecoder().decode(fetched) === '<workout_file/>');
  check('from its content-hash key', ok.calls.some((c) => c.url === `${BASE}/${file.key}`));
});

const down = new CatalogClient(BASE, async () => { throw new TypeError('Failed to fetch'); });
const downResult = await down.loadIndex();
const missing = new CatalogClient(BASE, stand({}).fetchFn);
const missingResult = await missing.loadIndex();

suite('an unreachable catalog', () => {
  check('network error reported, not thrown', !downResult.ok && downResult.reason === 'network', JSON.stringify(downResult));
  check('says it is unavailable', !downResult.ok && /unavailable/.test(downResult.message));
  check('a 404 index is unavailable too', !missingResult.ok && missingResult.reason === 'network'
    && /404/.test(missingResult.message));
});

const newer = await new CatalogClient(BASE, stand({ [`${BASE}/index.json`]: json({ ...index, version: 2 }) }).fetchFn).loadIndex();
const garbage = await new CatalogClient(BASE, stand({ [`${BASE}/index.json`]: () => new Response('<html>') }).fetchFn).loadIndex();
const damaged = await new CatalogClient(BASE, stand({ [`${BASE}/index.json`]: json({ version: 1 }) }).fetchFn).loadIndex();

suite('an index the app cannot use', () => {
  check('newer major version refused for its version', !newer.ok && newer.reason === 'version'
    && /newer version of the app/.test(newer.message));
  check('not JSON: unavailable', !garbage.ok && garbage.reason === 'network');
  check('damaged: refused as damaged', !damaged.ok && damaged.reason === 'shape');
});

const unconfigured = new CatalogClient('', async () => { throw new Error('must not be called'); });
const unconfiguredResult = await unconfigured.loadIndex();

suite('no catalog configured', () => {
  check('reported as unconfigured', !unconfiguredResult.ok && unconfiguredResult.reason === 'unconfigured');
  check('configured is false', !unconfigured.configured && okClient.configured);
});

const stale = new CatalogClient(BASE, stand({ [`${BASE}/${file.key}`]: () => new Response('something else') }).fetchFn);
let staleError: Error | undefined;
try { await stale.fetchFile(file); } catch (err) { staleError = err as Error; }
const gone = new CatalogClient(BASE, stand({}).fetchFn);
let goneError: Error | undefined;
try { await gone.fetchFile(file); } catch (err) { goneError = err as Error; }
const offline = new CatalogClient(BASE, async () => { throw new TypeError('Failed to fetch'); });
let offlineError: Error | undefined;
try { await offline.fetchFile(file); } catch (err) { offlineError = err as Error; }

suite('a file that cannot be used', () => {
  check('hash mismatch: refused as out of date', /out of date/.test(staleError?.message ?? ''), staleError?.message);
  check('404: could not download', /Could not download.*404/.test(goneError?.message ?? ''), goneError?.message);
  check('offline: could not download', /Could not download.*Failed to fetch/.test(offlineError?.message ?? ''),
    offlineError?.message);
});

report();
