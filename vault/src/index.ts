/**
 * Backup vault — a Cloudflare Worker in front of a private R2 bucket.
 *
 * Holds one encrypted backup per recovery key and can read none of them: the
 * browser encrypts with a key derived from the rider's recovery key, which
 * never leaves it, and authenticates with a separate token derived from the
 * same key. The vault keeps only the token's SHA-256 as the object's name, so
 * there are no accounts to look up and a wrong token simply addresses a
 * different, empty slot.
 *
 * The last backup wins: there are no preconditions and no conflict handling,
 * by the rider's choice.
 *
 * Nothing is logged: no bodies, no tokens.
 */

import { BACKUP_PATH, MAX_BACKUP_BYTES } from './limits';

/** The parts of an R2 bucket the vault uses. */
export interface VaultBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; uploaded: Date } | null>;
  put(key: string, value: Uint8Array): Promise<{ uploaded: Date } | null>;
  delete(key: string): Promise<void>;
}

/** Workers' rate-limit binding. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  VAULT: VaultBucket;
  WRITE_LIMITER: RateLimiter;
  READ_LIMITER: RateLimiter;
  /** Comma-separated origins allowed to call the vault. */
  APP_ORIGINS: string;
}

/** 32 bytes, base64url: exactly what the app derives. */
const TOKEN = /^Bearer ([A-Za-z0-9_-]{43})$/;

async function slotFor(token: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return `backups/${Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The body, or undefined once it passes the cap. `Content-Length` is checked
 *  first, but it can lie, so the bytes are counted too. */
async function readCapped(req: Request): Promise<Uint8Array | undefined> {
  const declared = Number(req.headers.get('Content-Length') ?? '0');
  if (declared > MAX_BACKUP_BYTES) return undefined;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BACKUP_BYTES) {
      await reader.cancel();
      return undefined;
    }
    parts.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { body.set(part, at); at += part.length; }
  return body;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // Not access control — anyone can forge Origin — but it keeps other sites'
    // pages from using the vault through a visitor's browser. The token is
    // the access control.
    const origin = req.headers.get('Origin') ?? '';
    const allowed = env.APP_ORIGINS.split(',').map((o) => o.trim());
    if (!allowed.includes(origin)) return new Response('forbidden', { status: 403 });

    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Expose-Headers': 'Last-Modified',
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (new URL(req.url).pathname !== BACKUP_PATH) return new Response('not found', { status: 404, headers: cors });
    if (!['GET', 'PUT', 'DELETE'].includes(req.method)) return new Response('method not allowed', { status: 405, headers: cors });

    const token = TOKEN.exec(req.headers.get('Authorization') ?? '')?.[1];
    if (!token) return new Response('unauthorized', { status: 401, headers: cors });

    const limiter = req.method === 'GET' ? env.READ_LIMITER : env.WRITE_LIMITER;
    const { success } = await limiter.limit({ key: req.headers.get('CF-Connecting-IP') ?? 'unknown' });
    if (!success) return new Response('too many requests', { status: 429, headers: cors });

    const slot = await slotFor(token);
    try {
      if (req.method === 'GET') {
        const object = await env.VAULT.get(slot);
        if (!object) return new Response('no backup', { status: 404, headers: cors });
        return new Response(await object.arrayBuffer(), {
          headers: { ...cors, 'Content-Type': 'application/octet-stream', 'Last-Modified': object.uploaded.toUTCString() },
        });
      }
      if (req.method === 'DELETE') {
        await env.VAULT.delete(slot);
        return new Response(null, { status: 204, headers: cors });
      }
      const body = await readCapped(req);
      if (!body) return new Response('too large', { status: 413, headers: cors });
      if (body.length === 0) return new Response('empty', { status: 400, headers: cors });
      const stored = await env.VAULT.put(slot, body);
      return Response.json({ uploaded: (stored?.uploaded ?? new Date()).getTime() }, { headers: cors });
    } catch {
      return new Response('storage unavailable', { status: 503, headers: cors });
    }
  },
};
