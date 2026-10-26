import type { RouteSummary, WorkoutSummary } from '../catalog/types';

/**
 * The app's one IndexedDB database. Version 1 holds My library (`files`) and
 * the followed plan (`plan`); version 2 adds done marks (`done`); version 3
 * adds the ride log (`rides`) and references to My library files that are
 * not on this device (`refs`). A later feature that needs storage (ride
 * persistence) bumps the version and adds its own stores in `upgrade`; it
 * never opens a second database.
 */
export const DB_NAME = 'cycle-indoors';
export const DB_VERSION = 3;
const FILES = 'files';
const PLAN = 'plan';
const DONE = 'done';
const RIDES = 'rides';
const REFS = 'refs';
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

/** A My library file known from a restored backup but not on this device:
 *  everything but the bytes. */
export type StoredRef = Omit<StoredFile, 'bytes'>;

/** A finished ride, as numbers only: never samples, a track or a file. */
export interface RideLogEntry {
  /** unix ms; the same key the summary uses for its Strava upload */
  startedAt: number;
  /** s */
  duration: number;
  /** m */
  distance: number;
  /** W */
  avgPower: number;
  normalisedPower: number;
  tss: number;
  avgHr?: number;
  /** m */
  ascent: number;
  /** the Library entry ridden, when it came from the Library or My library,
   *  and its file's content hash, so Ride same session can find it again */
  workout?: { key?: string; sha256?: string; title: string };
  route?: { key?: string; sha256?: string; name: string };
  stravaActivityId?: number;
}

/** Everything a restore replaces in the database. */
export interface StoredProfile {
  done: DoneMark[];
  followed?: string;
  /** My library as references: files and refs alike */
  library: StoredRef[];
  rides: RideLogEntry[];
}

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
  /** the ride log, newest first */
  rides(): Promise<RideLogEntry[]>;
  /** Logs a ride; logging the same start time again replaces it, keeping
   *  its Strava link. */
  logRide(entry: RideLogEntry): Promise<void>;
  /** Links a logged ride to its Strava activity; an unknown ride is ignored. */
  setRideStrava(startedAt: number, activityId: number): Promise<void>;
  removeRide(startedAt: number): Promise<void>;
  /** My library files not on this device, most recently used first */
  refs(): Promise<StoredRef[]>;
  /** Forgets a reference, and its done mark with it. */
  removeRef(sha256: string): Promise<void>;
  /** Replaces done marks, the followed plan, the ride log and My library with
   *  `profile`, all or nothing. Kept files the profile lists keep their
   *  bytes; every other kept file is deleted. */
  replaceProfile(profile: StoredProfile): Promise<void>;
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
  rides: async () => [],
  logRide: async () => {},
  setRideStrava: async () => {},
  removeRide: async () => {},
  refs: async () => [],
  removeRef: async () => {},
  replaceProfile: async () => {},
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
    // One transaction, so two loads of the same file cannot both "add" it,
    // and a file arriving for a reference replaces it in the same step.
    const tx = this.db.transaction([FILES, REFS], 'readwrite');
    const store = tx.objectStore(FILES);
    const existing = await request(store.get(file.sha256) as IDBRequest<StoredFile | undefined>);
    const now = this.now();
    store.put(existing ? { ...existing, lastUsedAt: now } : { ...file, addedAt: now, lastUsedAt: now });
    tx.objectStore(REFS).delete(file.sha256);
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

  async rides(): Promise<RideLogEntry[]> {
    const tx = this.db.transaction(RIDES, 'readonly');
    const all = await request(tx.objectStore(RIDES).getAll() as IDBRequest<RideLogEntry[]>);
    return all.sort((a, b) => b.startedAt - a.startedAt);
  }

  async logRide(entry: RideLogEntry): Promise<void> {
    const tx = this.db.transaction(RIDES, 'readwrite');
    const store = tx.objectStore(RIDES);
    // A summary shown again logs the ride again; it must not lose its Strava link.
    const existing = await request(store.get(entry.startedAt) as IDBRequest<RideLogEntry | undefined>);
    const activity = entry.stravaActivityId ?? existing?.stravaActivityId;
    store.put(activity === undefined ? entry : { ...entry, stravaActivityId: activity });
    await finished(tx);
  }

  async setRideStrava(startedAt: number, activityId: number): Promise<void> {
    const tx = this.db.transaction(RIDES, 'readwrite');
    const store = tx.objectStore(RIDES);
    const ride = await request(store.get(startedAt) as IDBRequest<RideLogEntry | undefined>);
    if (ride) store.put({ ...ride, stravaActivityId: activityId });
    await finished(tx);
  }

  async removeRide(startedAt: number): Promise<void> {
    const tx = this.db.transaction(RIDES, 'readwrite');
    tx.objectStore(RIDES).delete(startedAt);
    await finished(tx);
  }

  async refs(): Promise<StoredRef[]> {
    const tx = this.db.transaction(REFS, 'readonly');
    const all = await request(tx.objectStore(REFS).getAll() as IDBRequest<StoredRef[]>);
    return all.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  async removeRef(sha256: string): Promise<void> {
    const tx = this.db.transaction([REFS, DONE], 'readwrite');
    tx.objectStore(REFS).delete(sha256);
    tx.objectStore(DONE).delete(`mine:${sha256}`);
    await finished(tx);
  }

  async replaceProfile(profile: StoredProfile): Promise<void> {
    // One transaction: a restore that fails anywhere leaves every store as it was.
    const tx = this.db.transaction([DONE, PLAN, RIDES, REFS, FILES], 'readwrite');
    const done = finished(tx);
    try {
      const files = tx.objectStore(FILES);
      const keys = await request(files.getAllKeys() as IDBRequest<string[]>);
      const kept = new Set(profile.library.map((ref) => ref.sha256));
      for (const sha of keys) if (!kept.has(sha)) files.delete(sha);
      const here = new Set(keys);

      const marks = tx.objectStore(DONE);
      marks.clear();
      for (const mark of profile.done) marks.put(mark);

      const plan = tx.objectStore(PLAN);
      if (profile.followed) plan.put({ planId: profile.followed }, FOLLOWED);
      else plan.delete(FOLLOWED);

      const rides = tx.objectStore(RIDES);
      rides.clear();
      for (const ride of profile.rides) rides.put(ride);

      const refs = tx.objectStore(REFS);
      refs.clear();
      for (const ref of profile.library) if (!here.has(ref.sha256)) refs.put(ref);
    } catch (err) {
      // A put that throws (a malformed record) would otherwise let every
      // write before it commit.
      tx.abort();
      await done.catch(() => {});
      throw err;
    }
    await done;
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
        if (!upgrading.objectStoreNames.contains(RIDES)) upgrading.createObjectStore(RIDES, { keyPath: 'startedAt' });
        if (!upgrading.objectStoreNames.contains(REFS)) upgrading.createObjectStore(REFS, { keyPath: 'sha256' });
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
