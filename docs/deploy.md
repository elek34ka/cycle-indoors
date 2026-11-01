# Server-side pieces

The app is a static site. Two small Cloudflare Workers sit beside it: the
Strava relay and the backup vault. Each is deployed on its own, from
its own folder, and neither is needed to run the app locally.

## Strava relay

Strava's OAuth token exchange and every token refresh require the app's client
secret, and Strava offers no PKCE or other flow for browser-only apps — so a
static site cannot connect to Strava on its own. `relay/src/index.ts` is a
Cloudflare Worker (free plan) that adds the secret to those two calls. It also
forwards the few Strava API calls the app makes once connected, so a rider
whose browser cannot reach `strava.com` (Strava is blocked in some countries)
needs it only for the approval page.

```
browser ── {code} or {refresh_token} ──▶ relay ── + client_secret ──▶ strava.com/oauth/token
browser ◀── access_token, refresh_token, expires_at, scope ──────────────────┘
browser ── POST /strava/uploads (Bearer, .fit) ──▶ relay ── as is ──▶ strava.com/api/v3/uploads
browser ◀── Strava's status and body, unchanged ─────────────────────────────┘
```

| Relay route | Method | Forwarded to |
|---|---|---|
| `/` | POST | `www.strava.com/oauth/token`, client id and secret added |
| `/strava/uploads` | POST | `www.strava.com/api/v3/uploads` |
| `/strava/uploads/<digits>` | GET | `www.strava.com/api/v3/uploads/<digits>` |
| `/strava/athlete` | GET | `www.strava.com/api/v3/athlete` |
| `/strava/deauthorize` | POST | `www.strava.com/oauth/deauthorize` |

Any other path is a 404 and a wrong method a 405, before Strava is contacted.
Strava's API moves to `https://api-v3.strava.com` from 2027-01-04; that is
`STRAVA_API_BASE` in the relay, so the app needs no release for it.

- **Stateless.** No storage, no logs. The athlete profile in Strava's token
  reply is dropped; only the tokens, expiry and scope come back.
- **Ride files are forwarded, never stored or logged.** The body is passed on
  byte for byte with only its `Content-Type` and the rider's own
  `Authorization: Bearer` header; the client secret is never added to these
  calls, and uploads and athlete without a bearer are a 401. Strava's status
  and body come back unchanged, so the app reads 401, 429 and processing
  errors as if it had called Strava itself. Tokens stay in the browser.
- **Origin allow-list** (`APP_ORIGINS` in `relay/wrangler.toml`): the Pages
  site and the dev server, on every route. It stops other sites' pages from
  using the relay through a visitor's browser; it is not access control, and
  does not need to be — a code is only useful for this app's own client id,
  and a forwarded call can do nothing its token could not do against Strava
  directly.
- Bad input is a 400 before Strava is contacted, Strava's own errors are passed
  through with its status, and an unreachable Strava is a 502.

Live at `https://cycle-indoors-strava-relay.elek34ka-cycle-indoors.workers.dev`
for Strava app `290716`, whose **Authorization Callback Domain** is
`elek34ka.github.io` (`localhost` and `127.0.0.1` are always allowed, so the
dev server needs nothing extra).

### Deploying it

The app's side of it is `src/activity/strava.ts`, which holds the relay URL
and client id; both are public.

The secret never goes in the repo: in production it is a Worker secret, and
locally it lives in the gitignored `relay/.dev.vars`.

```sh
cd relay
npm install                                    # wrangler, kept out of the app's dependencies
npx wrangler login
npx wrangler secret put STRAVA_CLIENT_SECRET   # paste at the hidden prompt
npm run deploy

cp .dev.vars.example .dev.vars                 # then paste the secret; for `npm run dev` on :8787
```

A freshly created `workers.dev` subdomain fails TLS for a few minutes while its
certificate is issued. To check a deploy, a made-up code must come back as
Strava's own `400 … AuthorizationCode invalid`:

```sh
curl -X POST https://cycle-indoors-strava-relay.elek34ka-cycle-indoors.workers.dev \
     -H "Origin: http://127.0.0.1:5173" -H "content-type: application/json" \
     -d '{"code":"nope"}'
```

and a forwarded call without a token must be refused by the relay itself:

```sh
curl -i https://cycle-indoors-strava-relay.elek34ka-cycle-indoors.workers.dev/strava/athlete \
     -H "Origin: http://127.0.0.1:5173"      # → HTTP/2 401, "unauthorized"
```

Deploy the relay **before** an app build that uses a new route. `POST /` never
changes shape, so pages still open on an older build keep working.

## Backup vault

`vault/src/index.ts` is a second Cloudflare Worker, in front of a **private**
R2 bucket, `cycle-indoors-vault`. It holds one encrypted backup per recovery
key and cannot read any of them. It is a separate bucket from the public
catalog bucket, with no r2.dev access, and a separate Worker from the Strava
relay, which stays stateless.

```
recovery key ──HKDF "auth/v1"──▶ token ── Authorization: Bearer ──▶ vault ── SHA-256(token) ──▶ R2 backups/<hex>
             └─HKDF "enc/v1"───▶ AES-GCM key (never leaves the page): gzip(JSON profile) → ciphertext ─┘
```

- **No accounts.** The object's name is the SHA-256 of the token, so there
  is nothing to look up. A wrong token simply addresses a different, empty
  slot, and the bucket's listing yields no tokens.
- **`GET /v1/backup`** returns the backup or 404. **`PUT`** replaces it with
  no preconditions, so the last backup wins. **`DELETE`** removes it.
- **Limits:**
  - **Size:** 256 KiB per backup, checked on `Content-Length` and on the bytes
    actually read. That is years of a profile, and useless for hosting files.
  - **Rate:** 10 writes and 60 reads per minute per client IP, using Workers'
    rate-limit binding.
- **Origin allow-list** (`APP_ORIGINS` in `vault/wrangler.toml`), as in the
  relay. The token is the access control.
- **Nothing is logged.** Bodies and tokens never are.

The app's side is `src/backup/`. Its `config.ts` holds the vault URL. While
that is empty, the Backup panel says backup is unavailable and makes no
request.

### Deploying it

```sh
cd vault
npm install                                    # wrangler, kept out of the app's dependencies
npx wrangler login
npx wrangler r2 bucket create cycle-indoors-vault   # leave public (r2.dev) access off
npm run deploy
```

Then put the deployed URL into `DEFAULT_VAULT_URL` in `src/backup/config.ts`.
`npm run dev` serves it on `:8787` with a local R2 under `vault/.wrangler`, and
`VITE_VAULT_URL=http://127.0.0.1:8787 npm run dev` points the app at it.

**Rolling back** means setting `DEFAULT_VAULT_URL` back to `''`. Stored
backups stay in the bucket until they are deleted.

To check a deploy, a made-up token must come back as `404 no backup`:

```sh
curl https://<vault-url>/v1/backup -H "Origin: http://127.0.0.1:5173" \
     -H "Authorization: Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
```
