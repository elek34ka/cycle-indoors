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

report();
