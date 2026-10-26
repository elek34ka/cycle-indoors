const { VaultClient, VaultError } = await import('../src/backup/vault');
const { VAULT_URL } = await import('../src/backup/config');
const { generateKey, formatKey, deriveKeys } = await import('../src/backup/key');
const { check, report, suite } = await import('./harness');

const key = generateKey();
const keyText = formatKey(key);
const { token } = await deriveKeys(key);

const sent: { url: string; method: string; headers: Record<string, string>; body?: Uint8Array }[] = [];
let reply: () => Response | Promise<Response> = () => new Response(null, { status: 204 });
const client = new VaultClient('https://vault.example/', async (url, init = {}) => {
  sent.push({
    url, method: init.method ?? 'GET',
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    ...(init.body ? { body: new Uint8Array(init.body as Uint8Array) } : {}),
  });
  return reply();
});

const failure = async (run: () => Promise<unknown>) => {
  try { await run(); return undefined; } catch (e) { return e instanceof VaultError ? e.reason : 'other'; }
};

const body = new Uint8Array([1, 2, 3]);
reply = () => Response.json({ uploaded: 1 });
await client.put(token, body);
reply = () => new Response(new Uint8Array([9, 8]));
const got = await client.get(token);
reply = () => new Response('no backup', { status: 404 });
const none = await client.get(token);
reply = () => new Response(null, { status: 204 });
await client.delete(token);

suite('talking to the vault', () => {
  check('the configured vault is an https origin with no path', /^https:\/\/[^/]+$/.test(VAULT_URL), VAULT_URL);
  check('one endpoint, without a doubled slash', sent.every((r) => r.url === 'https://vault.example/v1/backup'));
  check('put sends the bytes', sent[0].method === 'PUT' && sent[0].body?.join() === '1,2,3');
  check('get returns the bytes', got?.join() === '9,8');
  check('no backup is undefined, not an error', none === undefined);
  check('delete', sent[3].method === 'DELETE');
  check('the token goes as a bearer token', sent.every((r) => r.headers.authorization === `Bearer ${token}`));
  const everything = JSON.stringify(sent.map((r) => ({ ...r, body: r.body ? Array.from(r.body) : undefined })));
  check('the recovery key is in no request', !everything.includes(keyText.slice(4)) && !everything.includes(keyText.slice(4).replace(/-/g, '')));
  check('only the token, and content type on a put', sent.every((r) => Object.keys(r.headers).every((h) => h === 'authorization' || h === 'content-type')));
});

const cases: [string, () => Response | Promise<Response>, string][] = [
  ['no network', () => { throw new TypeError('Failed to fetch'); }, 'offline'],
  ['429', () => new Response('', { status: 429 }), 'rate-limited'],
  ['413', () => new Response('', { status: 413 }), 'too-large'],
  ['503', () => new Response('', { status: 503 }), 'unavailable'],
  ['403', () => new Response('', { status: 403 }), 'refused'],
];
const reasons: string[] = [];
for (const [, r] of cases) {
  reply = r;
  reasons.push(String(await failure(() => client.put(token, body))));
}
reply = () => new Response('', { status: 404 });
const putNotFound = await failure(() => client.put(token, body));

suite('failures say why', () => {
  for (let i = 0; i < cases.length; i++) check(`${cases[i][0]} → ${cases[i][2]}`, reasons[i] === cases[i][2], reasons[i]);
  check('a 404 is only "no backup" for a get', putNotFound === 'refused');
  check('the messages are for riders', new VaultError('offline').message.includes('could not be reached'));
});

report();
