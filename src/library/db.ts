import type { RouteSummary, WorkoutSummary } from '../catalog/types';

/**
 * The app's one IndexedDB database. Version 1 holds My library (`files`) and
 * the followed plan (`plan`); version 2 adds done marks (`done`). A later
 * feature that needs storage (ride persistence) bumps the version and adds
 * its own stores in `upgrade`; it never opens a second database.
 */
export const DB_NAME = 'cycle-indoors';
export const DB_VERSION = 2;
const FILES = 'files';
const PLAN = 'plan';
const DONE = 'done';
const FOLLOWED = 'followed';

export interface StoredWorkout extends WorkoutSummary {
  title: string;
  author?: string;
  description?: string;
}

export interface StoredRoute extends RouteSummary {
  name: string;
}

/** A file the rider loaded, kept with its original bytes so it loads exactly
 *  as it did the first time. A FIT file can be both a workout and a route. */
export interface StoredFile {
  /** SHA-256 of `bytes`, so the same file is only ever kept once */
  sha256: string;
  name: string;
  bytes: Uint8Array;
  /** unix ms */
  addedAt: number;
  lastUsedAt: number;
  workout?: StoredWorkout;
  route?: StoredRoute;
}

export type NewFile = Omit<StoredFile, 'addedAt' | 'lastUsedAt'>;

/** A workout the rider marked done, by Library entry key
 *  (`builtin:<id>`, `catalog:<id>`, `mine:<sha256>`). */
export interface DoneMark {
  key: string;
  /** unix ms */
  doneAt: number;
}

export interface LibraryStore {
  /** false when the browser would not give us storage; every read is then
   *  empty and every write reports `unavailable` */
  readonly available: boolean;
  /** most recently used first */
  list(): Promise<StoredFile[]>;
  get(sha256: string): Promise<StoredFile | undefined>;
  /** Keeps a file; an identical one already kept only has its last-used time
   *  updated. Rejects when storage is full or fails. */
  save(file: NewFile): Promise<'added' | 'updated' | 'unavailable'>;
  /** Marks a kept file as just used. */
  touch(sha256: string): Promise<void>;
  /** Forgets a kept file, and its done mark with it. */
  remove(sha256: string): Promise<void>;
  doneMarks(): Promise<DoneMark[]>;
  /** Marks an entry done now, or clears its mark. */
  setDone(key: string, done: boolean): Promise<void>;
  /** the followed plan's id, if any */
  followed(): Promise<string | undefined>;
  follow(planId: string | undefined): Promise<void>;
}

/** Storage the browser refused: private windows, blocked site data. */
export const UNAVAILABLE_STORE: LibraryStore = {
  available: false,
  list: async () => [],
  get: async () => undefined,
  save: async () => 'unavailable',
  touch: async () => {},
  remove: async () => {},
  doneMarks: async () => [],
  setDone: async () => {},
  followed: async () => undefined,
  follow: async () => {},
};

const request = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

const finished = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error ?? new Error('storage transaction aborted'));
});

class IdbLibraryStore implements LibraryStore {
  readonly available = true;

  constructor(private readonly db: IDBDatabase, private readonly now: () => number) {}

  async list(): Promise<StoredFile[]> {
    const tx = this.db.transaction(FILES, 'readonly');
    const all = await request(tx.objectStore(FILES).getAll() as IDBRequest<StoredFile[]>);
    return all.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  async get(sha256: string): Promise<StoredFile | undefined> {
    const tx = this.db.transaction(FILES, 'readonly');
    return request(tx.objectStore(FILES).get(sha256) as IDBRequest<StoredFile | undefined>);
  }

  async save(file: NewFile): Promise<'added' | 'updated'> {
    // One transaction, so two loads of the same file cannot both "add" it.
    const tx = this.db.transaction(FILES, 'readwrite');
    const store = tx.objectStore(FILES);
    const existing = await request(store.get(file.sha256) as IDBRequest<StoredFile | undefined>);
    const now = this.now();
    store.put(existing ? { ...existing, lastUsedAt: now } : { ...file, addedAt: now, lastUsedAt: now });
    await finished(tx);
    return existing ? 'updated' : 'added';
  }

  async touch(sha256: string): Promise<void> {
    const tx = this.db.transaction(FILES, 'readwrite');
    const store = tx.objectStore(FILES);
    const existing = await request(store.get(sha256) as IDBRequest<StoredFile | undefined>);
    if (existing) store.put({ ...existing, lastUsedAt: this.now() });
    await finished(tx);
  }

  async remove(sha256: string): Promise<void> {
    // One transaction: a file never outlives its mark, or the reverse.
    const tx = this.db.transaction([FILES, DONE], 'readwrite');
    tx.objectStore(FILES).delete(sha256);
    tx.objectStore(DONE).delete(`mine:${sha256}`);
    await finished(tx);
  }

  async doneMarks(): Promise<DoneMark[]> {
    const tx = this.db.transaction(DONE, 'readonly');
    return request(tx.objectStore(DONE).getAll() as IDBRequest<DoneMark[]>);
  }

  async setDone(key: string, done: boolean): Promise<void> {
    const tx = this.db.transaction(DONE, 'readwrite');
    if (done) tx.objectStore(DONE).put({ key, doneAt: this.now() } satisfies DoneMark);
    else tx.objectStore(DONE).delete(key);
    await finished(tx);
  }

  async followed(): Promise<string | undefined> {
    const tx = this.db.transaction(PLAN, 'readonly');
    const record = await request(tx.objectStore(PLAN).get(FOLLOWED) as IDBRequest<{ planId: string } | undefined>);
    return record?.planId;
  }

  async follow(planId: string | undefined): Promise<void> {
    const tx = this.db.transaction(PLAN, 'readwrite');
    if (planId) tx.objectStore(PLAN).put({ planId }, FOLLOWED);
    else tx.objectStore(PLAN).delete(FOLLOWED);
    await finished(tx);
  }
}

/**
 * Opens the database, creating it on first use. Never rejects: a browser that
 * will not give us storage gets `UNAVAILABLE_STORE`, and the app carries on
 * without My library.
 */
export async function openLibraryStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
  now: () => number = Date.now,
): Promise<LibraryStore> {
  if (!factory) return UNAVAILABLE_STORE;
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const upgrading = open.result;
        if (!upgrading.objectStoreNames.contains(FILES)) upgrading.createObjectStore(FILES, { keyPath: 'sha256' });
        if (!upgrading.objectStoreNames.contains(PLAN)) upgrading.createObjectStore(PLAN);
        if (!upgrading.objectStoreNames.contains(DONE)) upgrading.createObjectStore(DONE, { keyPath: 'key' });
      };
      open.onsuccess = () => {
        // A newer tab upgrading the database must not be blocked by this one.
        open.result.onversionchange = () => open.result.close();
        resolve(open.result);
      };
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error('the database is held open by an older tab'));
    });
    return new IdbLibraryStore(db, now);
  } catch {
    return UNAVAILABLE_STORE;
  }
}
