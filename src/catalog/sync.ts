import type { BuiltFile, CatalogBuild } from './build';
import { validateIndex, type CatalogIndex } from './types';

export const INDEX_KEY = 'index.json';
/** Hashed files never change behind their key. */
export const FILE_CACHE = 'public, max-age=31536000, immutable';
/** Riders see a new catalog within a minute of a sync. */
export const INDEX_CACHE = 'public, max-age=60';

/** What a sync will do, in the order it must happen: every upload, then the
 *  index, then the deletes. */
export interface SyncPlan {
  uploads: string[];
  /** false when the catalog is unchanged apart from its build time */
  writeIndex: boolean;
  deletes: string[];
}

function keysOf(index: CatalogIndex | undefined): Set<string> {
  if (!index) return new Set();
  return new Set([...index.workouts, ...index.routes].map((e) => e.file.key));
}

/** The index without its build time, for telling whether anything changed. */
const content = (index: CatalogIndex) => JSON.stringify({ ...index, builtAt: undefined });

/**
 * Files are content-addressed, so the diff is set arithmetic on keys: upload
 * what the bucket's index does not list, delete what the new one no longer
 * lists. `old` is undefined for an empty bucket.
 */
export function planSync(old: CatalogIndex | undefined, next: CatalogIndex): SyncPlan {
  const before = keysOf(old);
  const after = keysOf(next);
  const uploads = [...after].filter((k) => !before.has(k)).sort();
  const deletes = [...before].filter((k) => !after.has(k)).sort();
  const writeIndex = !old || uploads.length > 0 || deletes.length > 0 || content(old) !== content(next);
  return { uploads, writeIndex, deletes };
}

/** The bucket operations a sync needs. The real one shells out to Wrangler. */
export interface BucketRunner {
  /** The stored object's text, or undefined when there is none. */
  get(key: string): Promise<string | undefined>;
  put(key: string, bytes: Uint8Array, contentType: string, cacheControl: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface SyncOptions {
  dryRun?: boolean;
  concurrency?: number;
  log?: (line: string) => void;
}

export interface SyncResult { plan: SyncPlan; uploaded: number; deleted: number; }

async function eachLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    // Once one upload fails, start no more; let the ones in flight finish.
    while (next < items.length && failure === undefined) {
      const item = items[next++];
      try { await run(item); } catch (err) { failure ??= err; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure;
}

/**
 * Publishes a build. The order is what keeps riders safe: the new index goes
 * up only after every file it points to is in the bucket, and files are
 * deleted only after no index points to them. A failure anywhere before the
 * index leaves the old catalog whole.
 */
export async function runSync(build: CatalogBuild, bucket: BucketRunner, options: SyncOptions = {}): Promise<SyncResult> {
  const log = options.log ?? (() => {});
  if (build.errors.length > 0) throw new Error('The catalog build failed; nothing was uploaded');

  const stored = await bucket.get(INDEX_KEY);
  let old: CatalogIndex | undefined;
  if (stored !== undefined) {
    let raw: unknown;
    try { raw = JSON.parse(stored); } catch { raw = undefined; }
    const checked = validateIndex(raw);
    // Without a readable old index there is no knowing what is safe to delete.
    if (!checked.ok) throw new Error(`The bucket's ${INDEX_KEY} cannot be read (${checked.message}); nothing was uploaded`);
    old = checked.index;
  }

  const plan = planSync(old, build.index);
  log(`${plan.uploads.length} to upload, ${plan.deletes.length} to delete, index ${plan.writeIndex ? 'changes' : 'unchanged'}`);
  if (options.dryRun) {
    for (const key of plan.uploads) log(`  would upload ${key}`);
    if (plan.writeIndex) log(`  would upload ${INDEX_KEY}`);
    for (const key of plan.deletes) log(`  would delete ${key}`);
    return { plan, uploaded: 0, deleted: 0 };
  }

  const byKey = new Map<string, BuiltFile>(build.files.map((f) => [f.key, f]));
  let uploaded = 0;
  await eachLimited(plan.uploads, options.concurrency ?? 4, async (key) => {
    const file = byKey.get(key);
    if (!file) throw new Error(`${key} is in the index but not in the build`);
    await bucket.put(key, file.bytes, file.contentType, FILE_CACHE);
    uploaded++;
    log(`  uploaded ${key}`);
  });

  if (plan.writeIndex) {
    const bytes = new TextEncoder().encode(JSON.stringify(build.index));
    await bucket.put(INDEX_KEY, bytes, 'application/json', INDEX_CACHE);
    log(`  uploaded ${INDEX_KEY}`);
  }

  // A failed delete only leaves an unreferenced file behind; carry on and
  // report it rather than fail a sync whose catalog is already live.
  let deleted = 0;
  const leftovers: string[] = [];
  for (const key of plan.deletes) {
    try {
      await bucket.delete(key);
      deleted++;
      log(`  deleted ${key}`);
    } catch (err) {
      leftovers.push(key);
      log(`  could not delete ${key}: ${(err as Error).message}`);
    }
  }
  if (leftovers.length > 0) log(`${leftovers.length} old file(s) left in the bucket; the next sync will not retry them`);
  return { plan, uploaded, deleted };
}
