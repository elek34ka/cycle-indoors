import { Emitter } from '../core/pubsub';

/**
 * Strava connection and upload.
 *
 * Strava needs the app's client secret to swap an authorization code for
 * tokens and for every refresh, so those two calls go through the relay in
 * `relay/`. Everything else — the approval page, uploads, polling,
 * deauthorizing — goes straight to Strava from the browser.
 *
 * The rider approves once per browser. The refresh token kept here then mints
 * a new 6-hour access token whenever one is needed, so the connection lasts
 * until the rider disconnects, revokes the app on Strava, or clears site data.
 */

export const STRAVA = {
  /** public; the secret lives only in the relay */
  clientId: '290716',
  relayUrl: 'https://cycle-indoors-strava-relay.elek34ka-cycle-indoors.workers.dev',
  authorizeUrl: 'https://www.strava.com/oauth/authorize',
  deauthorizeUrl: 'https://www.strava.com/oauth/deauthorize',
  /** moves to https://api-v3.strava.com from 2027-01-04 */
  apiBase: 'https://www.strava.com/api/v3',
  scope: 'activity:write',
};

/** `public/strava-callback.html` posts the approval result on this channel. */
export const CALLBACK_CHANNEL = 'cycle-indoors.strava-auth';
export const CALLBACK_PAGE = 'strava-callback.html';

const STORAGE_KEY = 'cycle-indoors.strava.v1';
/** an access token this close to expiry is refreshed first */
const EXPIRY_MARGIN_S = 120;
/** how long a pending approval is waited for before giving up */
export const CONNECT_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 2000;
const POLL_ATTEMPTS = 30;

export type StravaStatus = 'disconnected' | 'connecting' | 'connected';

/** What the callback page reports: Strava's redirect query, verbatim. */
export interface CallbackMessage {
  state: string | null;
  code: string | null;
  scope: string | null;
  error: string | null;
}

interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** unix seconds */
  expiresAt: number;
  scope: string;
  athleteName?: string;
}

export interface UploadMeta {
  name: string;
  description?: string;
  /** also the file name; Strava uses it to spot the same ride sent twice */
  externalId: string;
}

export type UploadResult =
  | { kind: 'created'; activityId: number; url: string }
  | { kind: 'duplicate'; activityId?: number; url?: string }
  /** accepted, but Strava had not finished processing it when we stopped asking */
  | { kind: 'processing' };

/** The rider has to connect (again) before this can work. */
export class StravaNotConnected extends Error {
  constructor(message = 'Not connected to Strava.') { super(message); }
}

export interface StravaDeps {
  fetch: typeof fetch;
  storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
  /** opens the approval page; null when a pop-up blocker stopped it */
  openPopup(url: string): unknown;
  /** listens for the callback page; returns a function that stops listening */
  listen(handler: (message: CallbackMessage) => void): () => void;
  callbackUrl(): string;
  randomState(): string;
  /** ms since the epoch */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** runs `fn` alone across this browser's tabs, so two tabs never spend the same rotating refresh token */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

/** The real browser. Every global is read at call time, so tests can swap them. */
export function browserDeps(): StravaDeps {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    storage: () => {
      try { return globalThis.localStorage; } catch { return undefined; }
    },
    openPopup: (url) => window.open(url, 'cycle-indoors-strava', 'popup,width=560,height=760'),
    listen: (handler) => {
      // Not window.opener/postMessage: if Strava's pages ever send
      // Cross-Origin-Opener-Policy, the popup loses its opener, but a
      // same-origin BroadcastChannel still reaches this tab.
      const channel = new BroadcastChannel(CALLBACK_CHANNEL);
      channel.onmessage = (e: MessageEvent) => handler(e.data as CallbackMessage);
      return () => channel.close();
    },
    callbackUrl: () => new URL(CALLBACK_PAGE, window.location.href).href,
    randomState: () => crypto.randomUUID(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    exclusive<T>(fn: () => Promise<T>): Promise<T> {
      const locks = (globalThis.navigator as Navigator | undefined)?.locks;
      return locks ? locks.request('cycle-indoors.strava-token', fn) as Promise<T> : fn();
    },
  };
}

export function authorizeUrl(state: string, redirectUri: string): string {
  const url = new URL(STRAVA.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: STRAVA.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    // A rider who already approved goes straight back without the consent page.
    approval_prompt: 'auto',
    scope: STRAVA.scope,
    state,
  }).toString();
  return url.href;
}

/** Strava separates scopes with commas in the redirect and spaces in the token reply. */
export function grantedScopes(scope: string | null | undefined): string[] {
  return (scope ?? '').split(/[\s,]+/).filter(Boolean);
}

/** The activity a "duplicate of …" upload error points at, when it names one. */
export function duplicateActivityId(error: string): number | undefined {
  if (!/duplicate of/i.test(error)) return undefined;
  const id = /activities\/(\d+)/.exec(error)?.[1] ?? /activity (\d+)/i.exec(error)?.[1];
  return id ? Number(id) : undefined;
}

export const activityUrl = (id: number) => `https://www.strava.com/activities/${id}`;

export class StravaClient extends Emitter<{ status: StravaStatus }> {
  private tokens: StoredTokens | undefined;
  private connecting = false;
  private cancelPending: ((reason: Error) => void) | undefined;

  constructor(private readonly deps: StravaDeps = browserDeps()) {
    super();
    this.tokens = this.load();
  }

  get status(): StravaStatus {
    if (this.connecting) return 'connecting';
    return this.tokens ? 'connected' : 'disconnected';
  }

  get athleteName(): string | undefined { return this.tokens?.athleteName; }

  /**
   * Open Strava's approval page in a pop-up and wait for the answer. Must be
   * called from a click, or the browser blocks the pop-up.
   */
  async connect(): Promise<void> {
    if (this.connecting) throw new Error('Already waiting for Strava.');
    const state = this.deps.randomState();
    if (!this.deps.openPopup(authorizeUrl(state, this.deps.callbackUrl()))) {
      throw new Error('The Strava window was blocked. Allow pop-ups for this site and try again.');
    }
    this.setConnecting(true);
    try {
      const message = await new Promise<CallbackMessage>((resolve, reject) => {
        const done = (error?: Error, value?: CallbackMessage) => {
          clearTimeout(timer);
          stop();
          this.cancelPending = undefined;
          if (error) reject(error); else resolve(value!);
        };
        const timer = setTimeout(() => done(new Error('Strava did not answer in time.')), CONNECT_TIMEOUT_MS);
        // A stale pop-up from an abandoned attempt carries another state.
        const stop = this.deps.listen((m) => { if (m?.state === state) done(undefined, m); });
        this.cancelPending = (reason) => done(reason);
      });

      if (message.error) {
        throw new Error(message.error === 'access_denied'
          ? 'Strava access was not granted.'
          : `Strava refused the connection (${message.error}).`);
      }
      if (!message.code) throw new Error('Strava sent no authorization code.');
      // Strava's consent page lets the rider untick individual permissions.
      if (!grantedScopes(message.scope).includes(STRAVA.scope)) {
        throw new Error('Upload permission was not granted. Connect again and leave “Upload your activities” ticked.');
      }

      this.save(await this.exchange({ code: message.code }));
      await this.fetchAthleteName();
    } finally {
      this.setConnecting(false);
    }
  }

  /** Stop waiting for an approval the rider abandoned. */
  cancelConnect(): void {
    this.cancelPending?.(new Error('Connecting to Strava was cancelled.'));
  }

  /** Revoke the app on Strava and forget the tokens. Forgets them even if Strava cannot be reached. */
  async disconnect(): Promise<void> {
    const token = await this.accessToken().catch(() => undefined);
    this.forget();
    if (!token) return;
    try {
      await this.deps.fetch(STRAVA.deauthorizeUrl, {
        method: 'POST',
        body: new URLSearchParams({ access_token: token }),
      });
    } catch { /* the tokens are gone from here either way */ }
  }

  /** Upload a FIT activity and wait for Strava to process it. */
  async upload(bytes: Uint8Array, meta: UploadMeta, onProgress?: (text: string) => void): Promise<UploadResult> {
    const token = await this.accessToken();
    const form = new FormData();
    form.append('file', new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' }), meta.externalId);
    form.append('data_type', 'fit');
    form.append('name', meta.name);
    if (meta.description) form.append('description', meta.description);
    form.append('trainer', '1');
    form.append('external_id', meta.externalId);

    onProgress?.('Uploading…');
    let upload = await this.api<UploadStatus>(token, '/uploads', { method: 'POST', body: form });
    onProgress?.('Processing…');

    for (let attempt = 0; ; attempt++) {
      if (upload.error) {
        if (/duplicate of/i.test(upload.error)) {
          const id = duplicateActivityId(upload.error);
          return id ? { kind: 'duplicate', activityId: id, url: activityUrl(id) } : { kind: 'duplicate' };
        }
        throw new Error(`Strava could not process the ride: ${stripTags(upload.error)}`);
      }
      if (upload.activity_id) {
        return { kind: 'created', activityId: upload.activity_id, url: activityUrl(upload.activity_id) };
      }
      if (attempt >= POLL_ATTEMPTS) return { kind: 'processing' };
      await this.deps.sleep(POLL_INTERVAL_MS);
      upload = await this.api<UploadStatus>(token, `/uploads/${upload.id}`);
    }
  }

  /** A valid access token, refreshed through the relay when it is about to expire. */
  private accessToken(): Promise<string> {
    return this.deps.exclusive(async () => {
      // Another tab may have refreshed (rotating the refresh token) or disconnected.
      this.tokens = this.load(this.tokens);
      const tokens = this.tokens;
      if (!tokens) throw new StravaNotConnected();
      if (tokens.expiresAt - EXPIRY_MARGIN_S > this.deps.now() / 1000) return tokens.accessToken;
      const fresh = await this.exchange({ refresh_token: tokens.refreshToken });
      this.save({ ...fresh, athleteName: tokens.athleteName });
      return fresh.accessToken;
    });
  }

  /** The relay call: an authorization code or a refresh token in, tokens out. */
  private async exchange(body: { code: string } | { refresh_token: string }): Promise<StoredTokens> {
    let res: Response;
    try {
      res = await this.deps.fetch(STRAVA.relayUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('Could not reach Strava. Check the connection and try again.');
    }
    if (!res.ok) {
      // A refresh token Strava no longer accepts means the app was revoked.
      if ('refresh_token' in body && (res.status === 400 || res.status === 401)) {
        this.forget();
        throw new StravaNotConnected('The Strava connection has expired. Connect again.');
      }
      throw new Error(`Strava sign-in failed (${res.status}).`);
    }
    const t = await res.json() as { access_token: string; refresh_token: string; expires_at: number; scope?: string };
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: t.expires_at, scope: t.scope ?? '' };
  }

  private async api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.deps.fetch(`${STRAVA.apiBase}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      throw new Error('Could not reach Strava. Check the connection and try again.');
    }
    if (res.status === 401) {
      this.forget();
      throw new StravaNotConnected('Strava no longer accepts this connection. Connect again.');
    }
    if (res.status === 429) throw new Error('Strava’s rate limit was reached. Try again in 15 minutes.');
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { message?: string };
      throw new Error(`Strava refused the request (${res.status}${body.message ? `: ${body.message}` : ''}).`);
    }
    return res.json() as Promise<T>;
  }

  /** "Connected as …" is a courtesy; failing to fetch it changes nothing. */
  private async fetchAthleteName(): Promise<void> {
    try {
      const token = await this.accessToken();
      const athlete = await this.api<{ firstname?: string; lastname?: string }>(token, '/athlete');
      const name = [athlete.firstname, athlete.lastname].filter(Boolean).join(' ');
      if (name && this.tokens) this.save({ ...this.tokens, athleteName: name });
    } catch { /* keep the connection, just without a name */ }
  }

  private setConnecting(on: boolean): void {
    this.connecting = on;
    this.emit('status', this.status);
  }

  /** The saved tokens; `fallback` when storage cannot be read at all. */
  private load(fallback?: StoredTokens): StoredTokens | undefined {
    try {
      const raw = this.deps.storage()?.getItem(STORAGE_KEY);
      if (raw === undefined) return fallback;
      if (!raw) return undefined;
      const t = JSON.parse(raw) as StoredTokens;
      return t.accessToken && t.refreshToken ? t : undefined;
    } catch {
      return fallback;
    }
  }

  /** Emits even when already connected, so the athlete's name reaches the panel. */
  private save(tokens: StoredTokens): void {
    this.tokens = tokens;
    try { this.deps.storage()?.setItem(STORAGE_KEY, JSON.stringify(tokens)); } catch { /* kept in memory */ }
    this.emit('status', this.status);
  }

  private forget(): void {
    const changed = Boolean(this.tokens);
    this.tokens = undefined;
    try { this.deps.storage()?.removeItem(STORAGE_KEY); } catch { /* non-fatal */ }
    if (changed) this.emit('status', this.status);
  }
}

interface UploadStatus {
  id: number;
  status?: string;
  error?: string | null;
  activity_id?: number | null;
}

/** Strava's upload errors sometimes carry an HTML link. */
function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, '');
}

export const strava = new StravaClient();
