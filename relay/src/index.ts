/**
 * Strava token relay — a Cloudflare Worker.
 *
 * Strava's token exchange and every refresh require the app's client secret,
 * which a browser-only app cannot hold. This adds it to exactly those two
 * calls and nothing else: the browser still uploads rides straight to Strava
 * with the access token, so ride data never passes through here.
 *
 * Stateless: no storage, no logging of request bodies.
 */

export interface Env {
  STRAVA_CLIENT_ID: string;
  /** Set with `wrangler secret put`, never in wrangler.toml. */
  STRAVA_CLIENT_SECRET: string;
  /** Comma-separated origins allowed to call the relay. */
  APP_ORIGINS: string;
}

export const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';

/** What the app needs from Strava's token response; the athlete profile is dropped. */
export interface RelayTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Not access control — anyone can forge Origin — but it keeps other sites'
    // pages from using the relay through a visitor's browser.
    const origin = req.headers.get('Origin') ?? '';
    const allowed = env.APP_ORIGINS.split(',').map((o) => o.trim());
    if (!allowed.includes(origin)) return new Response('forbidden', { status: 403 });

    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: cors });

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
  },
};
