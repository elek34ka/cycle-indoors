import { CATALOG_URL, catalogUrl } from './config';
import { sha256 } from './hash';
import { validateIndex, type CatalogFile, type CatalogIndex } from './types';

/** Why the catalog cannot be listed. */
export type CatalogFailure = 'unconfigured' | 'network' | 'version' | 'shape';

export type IndexResult =
  | { ok: true; index: CatalogIndex }
  | { ok: false; reason: CatalogFailure; message: string };

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Reads the published catalog. The index is fetched once and kept until the
 * Library asks for a fresh copy (each time it opens, and on Retry). Files are
 * fetched only when a rider loads one, and checked against the index's hash.
 * Nothing at boot waits on any of this.
 */
export class CatalogClient {
  private pending: Promise<IndexResult> | undefined;

  constructor(
    private readonly base: string = CATALOG_URL,
    private readonly fetchFn: Fetch = (url, init) => fetch(url, init),
  ) {}

  get configured(): boolean { return catalogUrl('index.json', this.base) !== undefined; }

  /** The index; `fresh` drops the copy already held and asks the network. */
  loadIndex(fresh = false): Promise<IndexResult> {
    if (fresh || !this.pending) this.pending = this.fetchIndex();
    return this.pending;
  }

  private async fetchIndex(): Promise<IndexResult> {
    const url = catalogUrl('index.json', this.base);
    if (!url) return { ok: false, reason: 'unconfigured', message: 'No catalog is set up for this app' };
    let raw: unknown;
    try {
      // no-cache revalidates with the bucket each time, so a sync shows up
      // as soon as its 60 s cache lifetime allows.
      const response = await this.fetchFn(url, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      raw = await response.json();
    } catch (err) {
      return { ok: false, reason: 'network', message: `The catalog is unavailable (${(err as Error).message})` };
    }
    const checked = validateIndex(raw);
    if (!checked.ok) return { ok: false, reason: checked.reason, message: checked.message };
    return { ok: true, index: checked.index };
  }

  /**
   * A catalog file's bytes. Throws with a message the rider can act on when it
   * cannot be downloaded, or when its bytes are not the ones the index
   * describes — then the index in hand is older than the bucket.
   */
  async fetchFile(file: CatalogFile): Promise<Uint8Array> {
    const url = catalogUrl(file.key, this.base);
    if (!url) throw new Error('No catalog is set up for this app');
    let bytes: Uint8Array;
    try {
      const response = await this.fetchFn(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      throw new Error(`Could not download it from the catalog (${(err as Error).message})`);
    }
    if (await sha256(bytes) !== file.sha256) {
      throw new Error('The catalog is out of date — reopen the Library and try again');
    }
    return bytes;
  }
}
