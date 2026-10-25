const { default: relay, STRAVA_TOKEN_URL } = await import('../relay/src/index');
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
const sent: { url: string; body: URLSearchParams }[] = [];
let stravaReply: () => Response = () => Response.json({});
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  sent.push({ url: String(url), body: new URLSearchParams(String(init?.body ?? '')) });
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
    check('preflight allows content-type', pre.headers.get('Access-Control-Allow-Headers') === 'content-type');
    check('GET is not allowed', get.status === 405, String(get.status));
    check('none of these reached Strava', sent.length === 0, String(sent.length));
  });
}

{
  const malformed = await post('{nope');
  const empty = await post({});
  const numeric = await post({ code: 42 });

  suite('bad input is refused before Strava sees it', () => {
    check('malformed JSON is a 400', malformed.status === 400, String(malformed.status));
    check('neither code nor refresh_token is a 400', empty.status === 400, String(empty.status));
    check('a non-string code is a 400', numeric.status === 400, String(numeric.status));
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

{
  const strava400 = { message: 'Bad Request', errors: [{ resource: 'AuthorizationCode', field: 'code', code: 'invalid' }] };
  stravaReply = () => Response.json(strava400, { status: 400 });
  const refused = await post({ code: 'stale' });
  const refusedBody = await refused.json();

  stravaReply = () => { throw new TypeError('network down'); };
  const down = await post({ code: 'abc' });

  suite('Strava failures reach the app', () => {
    check('Strava\'s status is passed through', refused.status === 400, String(refused.status));
    check('Strava\'s error body is passed through', JSON.stringify(refusedBody) === JSON.stringify(strava400));
    check('errors carry the CORS header', refused.headers.get('Access-Control-Allow-Origin') === APP);
    check('an unreachable Strava is a 502', down.status === 502, String(down.status));
    check('a 502 carries the CORS header', down.headers.get('Access-Control-Allow-Origin') === APP);
  });
}

globalThis.fetch = realFetch;
report();
