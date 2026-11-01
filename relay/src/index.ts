/**
 * Strava relay — a Cloudflare Worker, and the app's only link to Strava once
 * the rider has connected.
 *
 * Two jobs:
 * - `POST /` adds the app's client secret to a token exchange or refresh,
 *   which a browser-only app cannot hold.
 * - `/strava/…` forwards the few Strava API calls the app makes (upload,
 *   upload status, athlete, deauthorize) with the rider's own bearer token,
 *   so a rider whose browser cannot reach strava.com can still upload. Only
 *   the approval page is ever opened on strava.com.
 *
 * Stateless: ride files, tokens and Strava's replies are forwarded, never
 * stored, and nothing about a request is logged.
 */

export interface Env {
  STRAVA_CLIENT_ID: string;
  /** Set with `wrangler secret put`, never in wrangler.toml. */
  STRAVA_CLIENT_SECRET: string;
  /** Comma-separated origins allowed to call the relay. */
  APP_ORIGINS: string;
}

export const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
/** moves to https://api-v3.strava.com from 2027-01-04; the app never sees it */
export const STRAVA_API_BASE = 'https://www.strava.com/api/v3';
export const STRAVA_DEAUTHORIZE_URL = 'https://www.strava.com/oauth/deauthorize';

/** What the app needs from Strava's token response; the athlete profile is dropped. */
export interface RelayTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope?: string;
}

interface ApiRoute {
  method: 'GET' | 'POST';
  /** the upstream URL, or undefined when the path is not this route */
  match(path: string): string | undefined;
  /** refused with 401 before Strava is contacted when no bearer token is sent */
  bearer: boolean;
}

/** Everything the relay forwards. Anything else is a 404, never a proxy. */
const API_ROUTES: ApiRoute[] = [
  { method: 'POST', bearer: true, match: (p) => (p === '/strava/uploads' ? `${STRAVA_API_BASE}/uploads` : undefined) },
  {
    method: 'GET', bearer: true,
    match: (p) => { const id = /^\/strava\/uploads\/(\d+)$/.exec(p)?.[1]; return id ? `${STRAVA_API_BASE}/uploads/${id}` : undefined; },
  },
  { method: 'GET', bearer: true, match: (p) => (p === '/strava/athlete' ? `${STRAVA_API_BASE}/athlete` : undefined) },
  // Strava takes the token as a form field here, as the app has always sent it.
  { method: 'POST', bearer: false, match: (p) => (p === '/strava/deauthorize' ? STRAVA_DEAUTHORIZE_URL : undefined) },
];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Not access control — anyone can forge Origin — but it keeps other sites'
    // pages from using the relay through a visitor's browser.
    const origin = req.headers.get('Origin') ?? '';
    const allowed = env.APP_ORIGINS.split(',').map((o) => o.trim());
    if (!allowed.includes(origin)) return new Response('forbidden', { status: 403 });

    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'content-type, authorization',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const path = new URL(req.url).pathname;
    if (path === '/') {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: cors });
      return exchangeToken(req, env, cors);
    }

    for (const route of API_ROUTES) {
      const upstream = route.match(path);
      if (!upstream) continue;
      if (req.method !== route.method) return new Response('method not allowed', { status: 405, headers: cors });
      return forward(req, route.method, upstream, route.bearer, cors);
    }
    return new Response('not found', { status: 404, headers: cors });
  },
};

/** `POST /`: an authorization code or a refresh token in, tokens out, with the secret added. */
async function exchangeToken(req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  let input: { code?: unknown; refresh_token?: unknown } = {};
  try {
    input = await req.json();
  } catch {
    // Falls through to the 400 below.
  }
  const code = typeof input?.code === 'string' ? input.code : '';
  const refreshToken = typeof input?.refresh_token === 'string' ? input.refresh_token : '';
  if (!code && !refreshToken) return new Response('bad request', { status: 400, headers: cors });

  const body = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
    ...(code
      ? { grant_type: 'authorization_code', code }
      : { grant_type: 'refresh_token', refresh_token: refreshToken }),
  });

  let upstream: Response;
  try {
    upstream = await fetch(STRAVA_TOKEN_URL, { method: 'POST', body });
  } catch {
    return new Response('strava unreachable', { status: 502, headers: cors });
  }
  const data = await upstream.json().catch(() => ({}));
  // Strava's own error body ("invalid code", ...) is safe to pass through.
  if (!upstream.ok) return Response.json(data, { status: upstream.status, headers: cors });

  const { access_token, refresh_token, expires_at, scope } = data as RelayTokens;
  const tokens: RelayTokens = { access_token, refresh_token, expires_at, scope };
  return Response.json(tokens, { headers: cors });
}

/**
 * Sends the request on to Strava and Strava's answer back, both untouched.
 * The body is buffered rather than streamed or parsed: a FIT file is small,
 * its multipart boundary rides along in Content-Type, and a buffer behaves
 * the same in Workers and in Node.
 */
async function forward(
  req: Request, method: 'GET' | 'POST', url: string, bearer: boolean, cors: Record<string, string>,
): Promise<Response> {
  const authorization = req.headers.get('Authorization');
  if (bearer && !/^Bearer \S/.test(authorization ?? '')) {
    return new Response('unauthorized', { status: 401, headers: cors });
  }
  // Only these two headers go on: no cookies, no client details.
  const headers: Record<string, string> = {};
  if (authorization) headers.Authorization = authorization;
  const contentType = req.headers.get('Content-Type');
  if (contentType) headers['Content-Type'] = contentType;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method,
      headers,
      body: method === 'POST' ? await req.arrayBuffer() : undefined,
    });
  } catch {
    return new Response('strava unreachable', { status: 502, headers: cors });
  }
  const out: Record<string, string> = { ...cors };
  const type = upstream.headers.get('Content-Type');
  if (type) out['Content-Type'] = type;
  return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: out });
}
