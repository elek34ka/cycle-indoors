const { default: vault } = await import('../vault/src/index');
const vaultModule = await import('../vault/src/index');
const { MAX_BACKUP_BYTES, BACKUP_PATH } = await import('../vault/src/limits');
const { check, report, suite } = await import('./harness');
type Env = import('../vault/src/index').Env;

/** R2, in memory. */
const objects = new Map<string, { bytes: Uint8Array; uploaded: Date }>();
let storageDown = false;
const bucket: Env['VAULT'] = {
  async get(key) {
    if (storageDown) throw new Error('r2 down');
    const o = objects.get(key);
    return o ? { arrayBuffer: async () => o.bytes.slice().buffer, uploaded: o.uploaded } : null;
  },
  async put(key, value) {
    if (storageDown) throw new Error('r2 down');
    const uploaded = new Date(1_800_000_000_000 + objects.size);
    objects.set(key, { bytes: new Uint8Array(value), uploaded });
    return { uploaded };
  },
  async delete(key) { objects.delete(key); },
};
/** Allows `budget` calls per key, then refuses. */
function limiter(budget: number): Env['WRITE_LIMITER'] & { calls: string[] } {
  const used = new Map<string, number>();
  const calls: string[] = [];
  return {
    calls,
    async limit({ key }) {
      calls.push(key);
      used.set(key, (used.get(key) ?? 0) + 1);
      return { success: used.get(key)! <= budget };
    },
  };
}
const writes = limiter(1000);
const reads = limiter(1000);
const env: Env = { VAULT: bucket, WRITE_LIMITER: writes, READ_LIMITER: reads, APP_ORIGINS: 'https://elek34ka.github.io, http://127.0.0.1:5173' };
const APP = 'https://elek34ka.github.io';
const URL_ = `https://vault.example.workers.dev${BACKUP_PATH}`;
const tokenA = 'A'.repeat(43);
const tokenB = 'b'.repeat(42) + '_';

const call = (method: string, opts: { token?: string; body?: BodyInit; origin?: string; headers?: Record<string, string>; url?: string; ip?: string } = {}) =>
  vault.fetch(new Request(opts.url ?? URL_, {
    method,
    headers: {
      Origin: opts.origin ?? APP,
      'CF-Connecting-IP': opts.ip ?? '203.0.113.1',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  }), env);

const blob = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

{
  const evil = await call('GET', { token: tokenA, origin: 'https://evil.example' });
  const preflight = await call('OPTIONS');
  const noToken = await call('GET');
  const badToken = await call('GET', { token: 'short' });
  const otherPath = await call('GET', { token: tokenA, url: 'https://vault.example.workers.dev/v1/other' });
  const post = await call('POST', { token: tokenA, body: 'x' });
  suite('who may call', () => {
    // workerd refuses to start a main module with any other runtime export.
    check('the Worker module exports only its handler', Object.keys(vaultModule).join() === 'default', Object.keys(vaultModule).join());
    check('a foreign origin is refused', evil.status === 403);
    check('the preflight allows the app', preflight.status === 204
      && preflight.headers.get('Access-Control-Allow-Origin') === APP
      && /authorization/.test(preflight.headers.get('Access-Control-Allow-Headers') ?? '')
      && /PUT/.test(preflight.headers.get('Access-Control-Allow-Methods') ?? ''));
    check('no token: 401', noToken.status === 401);
    check('a malformed token: 401', badToken.status === 401);
    check('only the backup path', otherPath.status === 404);
    check('only GET, PUT and DELETE', post.status === 405);
  });
}

{
  const nothing = await call('GET', { token: tokenA });
  const put = await call('PUT', { token: tokenA, body: blob(1000, 1) });
  const putBody = await put.json() as { uploaded: number };
  const got = await call('GET', { token: tokenA });
  const gotBytes = new Uint8Array(await got.arrayBuffer());
  const otherRider = await call('GET', { token: tokenB });
  const keys = [...objects.keys()];
  const again = await call('PUT', { token: tokenA, body: blob(500, 2) });
  const second = new Uint8Array(await (await call('GET', { token: tokenA })).arrayBuffer());
  suite('one backup per key', () => {
    check('none at first: 404', nothing.status === 404);
    check('a put stores it', put.status === 200 && typeof putBody.uploaded === 'number');
    check('and a get returns it, byte for byte', got.status === 200 && gotBytes.length === 1000 && gotBytes.every((b) => b === 1));
    check('with when it was stored, readable by the app', got.headers.get('Last-Modified') !== null
      && /Last-Modified/.test(got.headers.get('Access-Control-Expose-Headers') ?? ''));
    check('never cached', got.headers.get('Cache-Control') === 'no-store');
    check('another token sees nothing', otherRider.status === 404);
    check('stored under the token\'s hash, not the token', keys.length === 1 && /^backups\/[0-9a-f]{64}$/.test(keys[0])
      && !keys[0].includes(tokenA));
    check('a second put simply replaces the first: the last backup wins', again.status === 200
      && second.length === 500 && second.every((b) => b === 2) && objects.size === 1);
  });
}

{
  const exact = await call('PUT', { token: tokenB, body: blob(MAX_BACKUP_BYTES) });
  const over = await call('PUT', { token: tokenA, body: blob(MAX_BACKUP_BYTES + 1, 9) });
  // A Content-Length that understates the body.
  const lyingRequest = new Request(URL_, {
    method: 'PUT',
    headers: { Origin: APP, Authorization: `Bearer ${tokenA}`, 'Content-Length': '10' },
    body: new ReadableStream({ start(c) { c.enqueue(blob(MAX_BACKUP_BYTES + 1, 9)); c.close(); } }),
    duplex: 'half',
  } as RequestInit);
  const lyingHeader = lyingRequest.headers.get('Content-Length');
  const lying = await vault.fetch(lyingRequest, env);
  const empty = await call('PUT', { token: tokenA, body: new Uint8Array() });
  const stillSecond = new Uint8Array(await (await call('GET', { token: tokenA })).arrayBuffer());
  suite('size', () => {
    check('256 KiB is accepted', exact.status === 200);
    check('256 KiB and a byte is refused', over.status === 413);
    check('also when Content-Length lies', lyingHeader === '10' && lying.status === 413, `${lyingHeader} → ${lying.status}`);
    check('an empty body is refused', empty.status === 400);
    check('nothing refused was stored', stillSecond.length === 500 && stillSecond.every((b) => b === 2));
  });
}

{
  const strict = limiter(2);
  const limited: Env = { ...env, WRITE_LIMITER: strict };
  const call2 = (ip: string) => vault.fetch(new Request(URL_, {
    method: 'PUT', body: blob(10), headers: { Origin: APP, Authorization: `Bearer ${tokenA}`, 'CF-Connecting-IP': ip },
  }), limited);
  const statuses = [(await call2('198.51.100.7')).status, (await call2('198.51.100.7')).status, (await call2('198.51.100.7')).status];
  const elsewhere = (await call2('198.51.100.8')).status;
  suite('rate limits', () => {
    check('writes are limited per client IP', statuses.join() === '200,200,429', statuses.join());
    check('another client is not affected', elsewhere === 200);
    check('reads use their own limit', reads.calls.length > 0 && !reads.calls.includes('198.51.100.7'));
  });
}

{
  const deleted = await call('DELETE', { token: tokenA });
  const gone = await call('GET', { token: tokenA });
  const deleteNothing = await call('DELETE', { token: 'z'.repeat(43) });
  storageDown = true;
  const down = await call('GET', { token: tokenB });
  storageDown = false;
  suite('delete and failures', () => {
    check('delete: 204', deleted.status === 204);
    check('then nothing: 404', gone.status === 404);
    check('deleting nothing is fine too', deleteNothing.status === 204);
    check('storage trouble: 503, with CORS so the app can read it', down.status === 503
      && down.headers.get('Access-Control-Allow-Origin') === APP);
  });
}

report();
