/**
 * The vault's client: one encrypted backup per token, fetched, replaced or
 * deleted. Only ever sends the token and ciphertext; the recovery key and the
 * encryption key never reach this file.
 */

export type VaultFailure = 'offline' | 'rate-limited' | 'too-large' | 'refused' | 'unavailable';

const MESSAGES: Record<VaultFailure, string> = {
  offline: 'The backup service could not be reached. Check the connection and try again.',
  'rate-limited': 'Too many attempts. Wait a minute and try again.',
  'too-large': 'The backup is too large for the service.',
  refused: 'The backup service refused the request.',
  unavailable: 'The backup service is unavailable right now. Try again later.',
};

export class VaultError extends Error {
  constructor(readonly reason: VaultFailure) { super(MESSAGES[reason]); }
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class VaultClient {
  private readonly endpoint: string;

  constructor(base: string, private readonly fetchFn: FetchFn = (input, init) => globalThis.fetch(input, init)) {
    this.endpoint = `${base.replace(/\/+$/, '')}/v1/backup`;
  }

  /** The stored backup, or undefined when there is none for this token. */
  async get(token: string): Promise<Uint8Array | undefined> {
    const res = await this.send('GET', token);
    if (res.status === 404) return undefined;
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Replaces the stored backup: the last one wins. */
  async put(token: string, bytes: Uint8Array): Promise<void> {
    await this.send('PUT', token, bytes);
  }

  async delete(token: string): Promise<void> {
    await this.send('DELETE', token);
  }

  private async send(method: string, token: string, body?: Uint8Array): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(this.endpoint, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/octet-stream' } : {}),
        },
        ...(body ? { body: body as BodyInit } : {}),
        cache: 'no-store',
      });
    } catch {
      throw new VaultError('offline');
    }
    if (res.ok || (method === 'GET' && res.status === 404)) return res;
    throw new VaultError(
      res.status === 429 ? 'rate-limited'
        : res.status === 413 ? 'too-large'
        : res.status >= 500 ? 'unavailable'
        : 'refused',
    );
  }
}
