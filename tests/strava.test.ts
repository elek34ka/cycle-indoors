const {
  StravaClient, StravaNotConnected, STRAVA, CALLBACK_CHANNEL, CALLBACK_PAGE,
  authorizeUrl, grantedScopes, duplicateActivityId,
} = await import('../src/activity/strava');
const { check, report, suite } = await import('./harness');
const { readFileSync } = await import('node:fs');
// An earlier DOM test may have installed jsdom's Blob, which Node's FormData rejects.
const { Blob: NodeBlob } = await import('node:buffer');
const previousBlob = globalThis.Blob;
globalThis.Blob = NodeBlob as typeof Blob;
type CallbackMessage = import('../src/activity/strava').CallbackMessage;
type StravaDeps = import('../src/activity/strava').StravaDeps;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const NOW = 1_800_000_000; // unix seconds

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

/**
 * A browser with a fake relay (tokens and forwarded Strava calls), pop-up and storage. `routes` answers
 * each request by URL; every request is recorded.
 */
function fakeBrowser(routes: Record<string, (call: Call) => Response | Promise<Response>> = {}) {
  const store = new Map<string, string>();
  const calls: Call[] = [];
  const listeners = new Set<(m: CallbackMessage) => void>();
  const popups: string[] = [];
  let clock = NOW * 1000;
  let popupBlocked = false;
  let lockDepth = 0;
  let maxLockDepth = 0;

  const deps: StravaDeps = {
    fetch: (async (input: string, init: RequestInit = {}) => {
      const url = String(input);
      const call: Call = {
        url,
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body,
      };
      calls.push(call);
      // Longest prefix wins: the token URL is a prefix of every forwarded call's.
      const route = Object.keys(routes).filter((prefix) => url.startsWith(prefix))
        .sort((a, b) => b.length - a.length)[0];
      if (!route) throw new TypeError(`no route for ${url}`);
      return routes[route](call);
    }) as typeof fetch,
    storage: () => ({
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => { store.set(k, v); },
      removeItem: (k) => { store.delete(k); },
    }),
    openPopup: (url) => { if (popupBlocked) return null; popups.push(url); return {}; },
    listen: (handler) => { listeners.add(handler); return () => listeners.delete(handler); },
    callbackUrl: () => 'https://elek34ka.github.io/cycle-indoors/strava-callback.html',
    randomState: () => 'state-1',
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    exclusive: async (fn) => {
      lockDepth++;
      maxLockDepth = Math.max(maxLockDepth, lockDepth);
      try { return await fn(); } finally { lockDepth--; }
    },
  };

  return {
    deps, store, calls, popups, listeners,
    get maxLockDepth() { return maxLockDepth; },
    blockPopups() { popupBlocked = true; },
    advance(seconds: number) { clock += seconds * 1000; },
    /** what the callback page would post */
    callback(m: Partial<CallbackMessage>) {
      const message = { state: 'state-1', code: null, scope: null, error: null, ...m };
      for (const l of [...listeners]) l(message);
    },
  };
}

const tokens = (n: number, expiresAt = NOW + 6 * 3600) => Response.json({
  access_token: `acc${n}`, refresh_token: `ref${n}`, expires_at: expiresAt, scope: 'activity:write read',
});
const relayRoute = (handler: (body: Record<string, string>) => Response) =>
  ({ [STRAVA.relayUrl]: (c: Call) => handler(JSON.parse(String(c.body))) });
const athleteRoute = { [`${STRAVA.relayApi}/athlete`]: () => Response.json({ firstname: 'Ada', lastname: 'Rider' }) };

/** A client that has connected once, with a token valid for six hours. */
async function connected(routes: Record<string, (call: Call) => Response | Promise<Response>> = {}) {
  let issued = 0;
  const browser = fakeBrowser({
    ...relayRoute(() => tokens(++issued)),
    ...athleteRoute,
    ...routes,
  });
  const client = new StravaClient(browser.deps);
  const done = client.connect();
  await flush();
  browser.callback({ code: 'c0de', scope: 'read,activity:write' });
  await done;
  browser.calls.length = 0;
  return { client, browser };
}

{
  let issued = 0;
  const browser = fakeBrowser({ ...relayRoute(() => tokens(++issued)), ...athleteRoute });
  const client = new StravaClient(browser.deps);
  const statuses: string[] = [];
  client.on('status', (s) => statuses.push(s));
  const startedDisconnected = client.status === 'disconnected';

  const done = client.connect();
  await flush();
  const waiting = client.status;
  browser.callback({ state: 'someone-else', code: 'stale', scope: 'activity:write' });
  await flush();
  const ignoredStale = client.status === 'connecting' && browser.calls.length === 0;
  browser.callback({ code: 'c0de', scope: 'read,activity:write' });
  await done;
  const exchange = browser.calls.find((c) => c.url === STRAVA.relayUrl);
  const saved = JSON.parse(browser.store.get('cycle-indoors.strava.v1') ?? '{}');

  suite('connecting', () => {
    check('starts disconnected', startedDisconnected);
    check('opens the approval page in a pop-up', browser.popups.length === 1 && browser.popups[0].startsWith(STRAVA.authorizeUrl));
    check('is connecting while the pop-up is open', waiting === 'connecting');
    check('ignores an answer meant for another attempt', ignoredStale);
    check('exchanges the code through the relay', JSON.parse(String(exchange?.body)).code === 'c0de');
    check('never sends a client secret from the browser', !JSON.stringify(browser.calls).includes('client_secret'));
    check('is connected afterwards', client.status === 'connected');
    check('stops listening for the callback', browser.listeners.size === 0);
    check('keeps the tokens in storage', saved.accessToken === 'acc1' && saved.refreshToken === 'ref1');
    check('learns the athlete’s name', client.athleteName === 'Ada Rider');
    check('announced connecting, then connected', statuses.includes('connecting') && statuses.at(-1) === 'connected', statuses.join());
  });

}

{
  const { client, browser } = await connected({
    [`${STRAVA.relayApi}/uploads`]: () => Response.json({ id: 1, status: 'Your activity is ready.', activity_id: 42 }),
  });
  await client.upload(new Uint8Array([1]), { name: 'R', externalId: 'r.fit' });
  const noRefresh = !browser.calls.some((c) => c.url === STRAVA.relayUrl);

  browser.advance(6 * 3600 - 60); // within two minutes of expiry
  browser.calls.length = 0;
  await client.upload(new Uint8Array([1]), { name: 'R', externalId: 'r.fit' });
  const refresh = browser.calls[0];
  const upload = browser.calls[1];
  const saved = JSON.parse(browser.store.get('cycle-indoors.strava.v1') ?? '{}');

  suite('tokens refresh without the rider', () => {
    check('a fresh token is used as it is', noRefresh);
    check('a token about to expire is refreshed first', refresh?.url === STRAVA.relayUrl, refresh?.url);
    check('the refresh sends the stored refresh token', JSON.parse(String(refresh?.body)).refresh_token === 'ref1');
    check('the upload uses the new access token', upload?.headers.Authorization === 'Bearer acc2');
    check('the rotated refresh token replaces the old one', saved.refreshToken === 'ref2');
    check('the name survives a refresh', saved.athleteName === 'Ada Rider');
    check('refreshing runs under the cross-tab lock', browser.maxLockDepth >= 1);
  });
}

{
  let polls = 0;
  const { client, browser } = await connected({
    [`${STRAVA.relayApi}/uploads/77`]: () => Response.json(
      ++polls < 3 ? { id: 77, status: 'Your activity is still being processed.' } : { id: 77, activity_id: 555 },
    ),
    [`${STRAVA.relayApi}/uploads`]: () => Response.json({ id: 77, status: 'Your activity is still being processed.' }),
  });
  const progress: string[] = [];
  const result = await client.upload(new Uint8Array([9, 8, 7]), {
    name: 'Sweet Spot', description: 'indoors', externalId: 'cycle-indoors-20261025-0700.fit',
  }, (t) => progress.push(t));
  const post = browser.calls[0];
  const form = post.body as FormData;
  const file = form.get('file') as File;

  suite('an upload', () => {
    check('posts to /uploads', post.url === `${STRAVA.relayApi}/uploads` && post.method === 'POST');
    check('authorises with the access token', post.headers.Authorization === 'Bearer acc1');
    check('sends the file as FIT', form.get('data_type') === 'fit');
    check('names the file by its external id', file?.name === 'cycle-indoors-20261025-0700.fit', file?.name);
    check('sends the bytes unchanged', file?.size === 3);
    check('names the activity', form.get('name') === 'Sweet Spot');
    check('passes the description', form.get('description') === 'indoors');
    check('marks it as a trainer ride', form.get('trainer') === '1');
    check('and asks for no sport type', form.get('sport_type') === null, String(form.get('sport_type')));
    check('sets the external id for duplicate detection', form.get('external_id') === 'cycle-indoors-20261025-0700.fit');
    check('polls until Strava has made the activity', polls === 3, String(polls));
    check('returns the activity and its link',
      result.kind === 'created' && result.activityId === 555 && result.url === 'https://www.strava.com/activities/555');
    check('reports its progress', progress.join(' → ') === 'Uploading… → Processing…', progress.join(' → '));
  });
}

{
  const outcome = async (reply: () => Response) => {
    const { client } = await connected({ [`${STRAVA.relayApi}/uploads`]: reply });
    return client.upload(new Uint8Array([1]), { name: 'R', externalId: 'r.fit' })
      .then((r) => r, (e: Error) => e);
  };
  const dup = await outcome(() => Response.json({ id: 1, error: "r.fit duplicate of <a href='/activities/31337'>Ride</a>" }));
  const bad = await outcome(() => Response.json({ id: 1, error: 'Improperly formatted <b>data</b>' }));
  const limited = await outcome(() => new Response('', { status: 429 }));
  const { client: revoked, browser: revokedBrowser } = await connected({
    [`${STRAVA.relayApi}/uploads`]: () => new Response('', { status: 401 }),
  });
  const revokedError = await revoked.upload(new Uint8Array([1]), { name: 'R', externalId: 'r.fit' }).catch((e) => e);
  const { client: slow } = await connected({
    [`${STRAVA.relayApi}/uploads`]: () => Response.json({ id: 5, status: 'Your activity is still being processed.' }),
  });
  const slowResult = await slow.upload(new Uint8Array([1]), { name: 'R', externalId: 'r.fit' });
  const offline = fakeBrowser({});
  offline.store.set('cycle-indoors.strava.v1', JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 3600, scope: '' }));
  const offlineError = await new StravaClient(offline.deps)
    .upload(new Uint8Array([1]), { name: 'R', externalId: 'r.fit' }).catch((e: Error) => e);
  const { client: stravaDownClient } = await connected({
    [`${STRAVA.relayApi}/uploads`]: () => new Response('strava unreachable', { status: 502 }),
  });
  const stravaDown = await stravaDownClient.upload(new Uint8Array([1]), { name: 'R', externalId: 'r.fit' })
    .catch((e: Error) => e);

  suite('upload outcomes', () => {
    check('a duplicate is reported with a link to the existing activity',
      !(dup instanceof Error) && dup.kind === 'duplicate' && dup.url === 'https://www.strava.com/activities/31337');
    check('a processing error is thrown without HTML',
      bad instanceof Error && bad.message.endsWith('Improperly formatted data'), String(bad));
    check('the rate limit is explained', limited instanceof Error && /rate limit/.test(limited.message));
    check('a 401 means "connect again"', revokedError instanceof StravaNotConnected);
    check('and forgets the tokens', revoked.status === 'disconnected' && revokedBrowser.store.size === 0);
    check('a slow Strava ends as "processing", not as a failure',
      slowResult.kind === 'processing', JSON.stringify(slowResult));
    check('no network is explained', offlineError instanceof Error
      && offlineError.message === 'Could not reach the upload service. Check the connection and try again.', String(offlineError));
    check('a Strava the relay cannot reach is explained', stravaDown instanceof Error
      && stravaDown.message === 'Strava could not be reached. Try again later.', String(stravaDown));
    check('and is not "connect again"', !(stravaDown instanceof StravaNotConnected) && stravaDownClient.status === 'connected');
  });
}

// Once connected, nothing goes to strava.com: it may be blocked where the rider is.
{
  let issued = 0;
  let polls = 0;
  const browser = fakeBrowser({
    // the refreshed token lasts six hours from when it is issued, past the jump below
    ...relayRoute(() => (++issued === 1 ? tokens(1) : tokens(issued, NOW + 13 * 3600))),
    ...athleteRoute,
    [`${STRAVA.relayApi}/uploads`]: () => Response.json({ id: 90, status: 'Your activity is still being processed.' }),
    [`${STRAVA.relayApi}/uploads/90`]: () => Response.json(++polls < 2 ? { id: 90 } : { id: 90, activity_id: 900 }),
    [`${STRAVA.relayApi}/deauthorize`]: () => Response.json({}),
  });
  const client = new StravaClient(browser.deps);
  const done = client.connect();
  await flush();
  browser.callback({ code: 'c0de', scope: 'read,activity:write' });
  await done;
  browser.advance(7 * 3600); // the next upload refreshes first
  const result = await client.upload(new Uint8Array([1]), { name: 'R', externalId: 'r.fit' });
  await client.disconnect();
  const urls = browser.calls.map((c) => c.url);
  const onStrava = urls.filter((u) => new URL(u).hostname.endsWith('strava.com'));
  const used = (path: string) => urls.includes(`${STRAVA.relayApi}${path}`);

  suite('once connected, only the relay is called', () => {
    check('only the approval pop-up opens Strava', browser.popups.length === 1
      && browser.popups[0].startsWith(STRAVA.authorizeUrl));
    check('no request goes to strava.com', onStrava.length === 0, onStrava.join(' '));
    check('every request goes to the relay', urls.every((u) => u.startsWith(STRAVA.relayUrl)), urls.join(' '));
    check('the code exchange and the refresh both went to it',
      browser.calls.filter((c) => c.url === STRAVA.relayUrl).length === 2);
    check('so did the athlete, the upload, its polls and the deauthorize',
      used('/athlete') && used('/uploads') && used('/uploads/90') && used('/deauthorize'), urls.join(' '));
    check('and the ride was created', result.kind === 'created' && result.activityId === 900, JSON.stringify(result));
  });
}

globalThis.Blob = previousBlob;
report();
