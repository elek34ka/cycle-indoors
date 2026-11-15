const { default: relay, STRAVA_TOKEN_URL, STRAVA_API_BASE, STRAVA_DEAUTHORIZE_URL } = await import('../relay/src/index');
const { check, report, suite } = await import('./harness');
type RelayTokens = import('../relay/src/index').RelayTokens;

const env = {
  STRAVA_CLIENT_ID: '290716',
  STRAVA_CLIENT_SECRET: 's3cret',
  APP_ORIGINS: 'https://elek34ka.github.io, http://127.0.0.1:5173',
};
const APP = 'https://elek34ka.github.io';
const RELAY = 'https://relay.example.workers.dev/';

/** Stands in for Strava's token endpoint and records what the relay sent it. */
interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** the token endpoint's form */
  body: URLSearchParams;
  /** the bytes as sent, for forwarded API calls */
  raw: Uint8Array | undefined;
}
const sent: Sent[] = [];
let stravaReply: () => Response = () => Response.json({});
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
  const raw = init.body instanceof ArrayBuffer ? new Uint8Array(init.body) : undefined;
  sent.push({
    url: String(url),
    method: init.method ?? 'GET',
    headers: { ...(init.headers as Record<string, string> | undefined) },
    body: new URLSearchParams(raw ? '' : String(init.body ?? '')),
    raw,
  });
  return stravaReply();
}) as typeof fetch;

const post = (body: unknown, origin = APP) =>
  relay.fetch(new Request(RELAY, {
    method: 'POST',
    headers: { Origin: origin, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }), env);

const tokenReply = {
  token_type: 'Bearer',
  access_token: 'acc',
  refresh_token: 'ref2',
  expires_at: 1_800_000_000,
  expires_in: 21600,
  scope: 'activity:write read',
  athlete: { id: 1, firstname: 'A' },
};

{
  const evil = await post({ code: 'x' }, 'https://evil.example');
  const noOrigin = await relay.fetch(new Request(RELAY, { method: 'POST', body: '{}' }), env);
  const pre = await relay.fetch(new Request(RELAY, {
    method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:5173' },
  }), env);
  const get = await relay.fetch(new Request(RELAY, { headers: { Origin: APP } }), env);

  suite('only the app\'s own origins may call it', () => {
    check('an unlisted origin is refused', evil.status === 403, String(evil.status));
    check('a refused origin gets no CORS header', !evil.headers.has('Access-Control-Allow-Origin'));
    check('a request with no Origin is refused', noOrigin.status === 403, String(noOrigin.status));
    check('preflight from the dev server succeeds', pre.status === 204, String(pre.status));
    check('preflight echoes that exact origin',
      pre.headers.get('Access-Control-Allow-Origin') === 'http://127.0.0.1:5173');
    check('preflight allows content-type',
      /\bcontent-type\b/.test(pre.headers.get('Access-Control-Allow-Headers') ?? ''),
      pre.headers.get('Access-Control-Allow-Headers') ?? '');
    check('GET is not allowed', get.status === 405, String(get.status));
    check('none of these reached Strava', sent.length === 0, String(sent.length));
  });
}

{
  stravaReply = () => Response.json(tokenReply);
  const res = await post({ code: 'abc' });
  const out = await res.json() as Record<string, unknown>;
  const req = sent.at(-1)!;

  suite('a code is exchanged with the secret added', () => {
    check('posts to Strava\'s token endpoint', req.url === STRAVA_TOKEN_URL, req.url);
    check('sends grant_type=authorization_code', req.body.get('grant_type') === 'authorization_code');
    check('forwards the code', req.body.get('code') === 'abc');
    check('adds the client id', req.body.get('client_id') === '290716');
    check('adds the client secret', req.body.get('client_secret') === 's3cret');
    check('replies 200', res.status === 200, String(res.status));
    check('returns the tokens and expiry',
      out.access_token === 'acc' && out.refresh_token === 'ref2' && out.expires_at === 1_800_000_000,
      JSON.stringify(out));
    check('returns the granted scope', out.scope === 'activity:write read');
    check('drops the athlete profile', !('athlete' in out));
    check('never echoes the secret', !JSON.stringify(out).includes('s3cret'));
    check('carries the CORS header', res.headers.get('Access-Control-Allow-Origin') === APP);
  });
}

{
  stravaReply = () => Response.json(tokenReply);
  const res = await post({ refresh_token: 'ref1' });
  const out = await res.json() as RelayTokens;
  const req = sent.at(-1)!;

  suite('a refresh gets the secret too', () => {
    check('sends grant_type=refresh_token', req.body.get('grant_type') === 'refresh_token');
    check('forwards the refresh token', req.body.get('refresh_token') === 'ref1');
    check('adds the client secret', req.body.get('client_secret') === 's3cret');
    check('sends no code', !req.body.has('code'));
    check('returns the rotated refresh token', out.refresh_token === 'ref2', out.refresh_token);
  });
}

// ---- Strava API calls forwarded for the app ----

const RELAY_ORIGIN = RELAY.replace(/\/$/, '');
const api = (path: string, init: RequestInit = {}, origin = APP) =>
  relay.fetch(new Request(`${RELAY_ORIGIN}${path}`, {
    ...init,
    headers: { Origin: origin, ...(init.headers as Record<string, string> | undefined) },
  }), env);
const bearer = { Authorization: 'Bearer acc' };

// Written by hand, not with FormData: jsdom's Blob is global in this process.
const BOUNDARY = '----cycleindoors7Mq';
const fitBytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) & 0xff);
const multipart = new Uint8Array([
  ...new TextEncoder().encode(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="data_type"\r\n\r\nfit\r\n`
    + `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="ride.fit"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n'),
  ...fitBytes,
  ...new TextEncoder().encode(`\r\n--${BOUNDARY}--\r\n`),
]);
const sameBytes = (a: Uint8Array | undefined, b: Uint8Array) =>
  !!a && a.length === b.length && a.every((v, i) => v === b[i]);

{
  sent.length = 0;
  stravaReply = () => Response.json({ id: 77, status: 'Your activity is still being processed.' }, { status: 201 });
  const res = await api('/strava/uploads', {
    method: 'POST',
    headers: { ...bearer, 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, Cookie: 'x=1' },
    body: multipart,
  });
  const out = await res.json() as { id: number };
  const req = sent.at(-1)!;

  suite('an upload is forwarded to Strava untouched', () => {
    check('posts to Strava\'s upload endpoint', req.url === `${STRAVA_API_BASE}/uploads` && req.method === 'POST',
      `${req.method} ${req.url}`);
    check('the body arrives byte for byte', sameBytes(req.raw, multipart), String(req.raw?.length));
    check('with the same multipart boundary',
      req.headers['Content-Type'] === `multipart/form-data; boundary=${BOUNDARY}`, req.headers['Content-Type']);
    check('with the rider\'s own bearer', req.headers.Authorization === 'Bearer acc', req.headers.Authorization);
    check('and no client secret anywhere', !JSON.stringify(req.headers).includes('s3cret')
      && !new TextDecoder().decode(req.raw).includes('s3cret'));
    check('no other header is forwarded', Object.keys(req.headers).sort().join() === 'Authorization,Content-Type',
      Object.keys(req.headers).join());
    check('Strava\'s status comes back', res.status === 201, String(res.status));
    check('Strava\'s body comes back', out.id === 77, JSON.stringify(out));
    check('Strava\'s content type comes back', res.headers.get('Content-Type')?.startsWith('application/json') === true);
    check('carries the CORS header', res.headers.get('Access-Control-Allow-Origin') === APP);
  });
}

{
  sent.length = 0;
  const noBearer = await api('/strava/uploads', { method: 'POST', body: 'x' });
  const notBearer = await api('/strava/athlete', { headers: { Authorization: 'Basic abc' } });
  const activities = await api('/strava/activities/1', { headers: bearer });
  const notNumeric = await api('/strava/uploads/abc', { headers: bearer });
  const nested = await api('/strava/uploads/77/extra', { headers: bearer });
  const unknownRoot = await api('/token', { method: 'POST', body: '{"code":"x"}' });
  const getUploads = await api('/strava/uploads', { headers: bearer });
  const postAthlete = await api('/strava/athlete', { method: 'POST', headers: bearer, body: 'x' });
  const evil = await api('/strava/uploads', { method: 'POST', headers: bearer, body: 'x' }, 'https://evil.example');
  const pre = await relay.fetch(new Request(`${RELAY_ORIGIN}/strava/uploads`, {
    method: 'OPTIONS',
    headers: { Origin: APP, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' },
  }), env);
  const allowHeaders = pre.headers.get('Access-Control-Allow-Headers') ?? '';
  const allowMethods = pre.headers.get('Access-Control-Allow-Methods') ?? '';

  suite('only the fixed set of calls is forwarded', () => {
    check('an upload without a bearer is a 401', noBearer.status === 401, String(noBearer.status));
    check('a non-bearer Authorization is a 401', notBearer.status === 401, String(notBearer.status));
    check('/strava/activities/1 is a 404', activities.status === 404, String(activities.status));
    check('a non-numeric upload id is a 404', notNumeric.status === 404, String(notNumeric.status));
    check('a path below an upload is a 404', nested.status === 404, String(nested.status));
    check('an unknown root path is a 404', unknownRoot.status === 404, String(unknownRoot.status));
    check('GET on the upload route is a 405', getUploads.status === 405, String(getUploads.status));
    check('POST on the athlete route is a 405', postAthlete.status === 405, String(postAthlete.status));
    check('an unlisted origin on an API route is a 403', evil.status === 403, String(evil.status));
    check('with no CORS header', !evil.headers.has('Access-Control-Allow-Origin'));
    check('none of these reached Strava', sent.length === 0, String(sent.length));
    check('preflight for an upload succeeds', pre.status === 204 && pre.headers.get('Access-Control-Allow-Origin') === APP);
    check('preflight allows the authorization header', /\bauthorization\b/i.test(allowHeaders), allowHeaders);
    check('preflight allows GET and POST', /\bGET\b/.test(allowMethods) && /\bPOST\b/.test(allowMethods), allowMethods);
  });
}

globalThis.fetch = realFetch;
report();
