import { sha256 } from '../catalog/hash';
import { summariseRoute, summariseWorkout } from '../catalog/summary';
import { Emitter } from '../core/pubsub';
import { baseName, type LoadResult } from '../loaders';
import { UNTITLED_WORKOUT } from '../workout/zwo';
import type { LibraryStore, RideLogEntry, StoredFile, StoredProfile, StoredRef, StoredRoute, StoredWorkout } from './db';

/** What happened to a file the rider loaded. */
export type KeepOutcome = 'added' | 'updated' | 'not-a-workout-or-route' | 'unavailable' | 'failed';

export interface KeepResult {
  outcome: KeepOutcome;
  /** when kept: the file's id in My library, and its workout's title */
  sha256?: string;
  workoutTitle?: string;
}

/**
 * My library: the files a rider has loaded, kept in the browser so they are
 * still in the Library after a reload. Wraps the store, which opens
 * asynchronously, so boot never waits on IndexedDB. Nothing here goes near
 * the network.
 */
export class PersonalLibrary extends Emitter<{ change: void }> {
  private askedToPersist = false;

  constructor(private readonly store: Promise<LibraryStore>) {
    super();
  }

  async available(): Promise<boolean> { return (await this.store).available; }

  /** Kept files, most recently used first. */
  async entries(): Promise<StoredFile[]> { return (await this.store).list(); }

  async file(sha: string): Promise<StoredFile | undefined> { return (await this.store).get(sha); }

  /**
   * Keeps a file that has just loaded, with the summaries the Library lists.
   * A FIT file that is both a workout and a route is kept once, as both.
   * Never throws; the outcome says whether the rider needs telling.
   */
  async keep(file: File, result: LoadResult): Promise<KeepResult> {
    try {
      const store = await this.store;
      if (!store.available) return { outcome: 'unavailable' };
      const workout = result.workout ? workoutOf(result, file.name) : undefined;
      const route = result.track ? routeOf(result) : undefined;
      if (!workout && !route) return { outcome: 'not-a-workout-or-route' };
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = await sha256(bytes);
      const outcome = await store.save({
        sha256: hash,
        name: file.name,
        bytes,
        ...(workout ? { workout } : {}),
        ...(route ? { route } : {}),
      });
      if (outcome === 'unavailable') return { outcome };
      if (outcome === 'added') this.persist();
      this.emit('change', undefined);
      return { outcome, sha256: hash, ...(workout ? { workoutTitle: workout.title } : {}) };
    } catch {
      // full, or the browser revoked storage mid-session
      return { outcome: 'failed' };
    }
  }

  /** Marks a kept file as just used, so it sorts first. */
  async used(sha: string): Promise<void> {
    try {
      await (await this.store).touch(sha);
      this.emit('change', undefined);
    } catch { /* ordering only */ }
  }

  async remove(sha: string): Promise<void> {
    await (await this.store).remove(sha);
    this.emit('change', undefined);
  }

  /** Done marks by entry key, with when each was made (unix ms). Empty when
   *  storage is unavailable. */
  async doneMarks(): Promise<Map<string, number>> {
    try {
      return new Map((await (await this.store).doneMarks()).map((m) => [m.key, m.doneAt]));
    } catch {
      return new Map();
    }
  }

  /** Marks a Library entry done now, or not done. Rejects when storage fails. */
  async setDone(key: string, done: boolean): Promise<void> {
    await (await this.store).setDone(key, done);
    this.emit('change', undefined);
  }

  async followed(): Promise<string | undefined> {
    try { return await (await this.store).followed(); } catch { return undefined; }
  }

  /** Follows a plan, replacing any other, or stops following. */
  async follow(planId: string | undefined): Promise<void> {
    await (await this.store).follow(planId);
    this.emit('change', undefined);
  }

  /** My library files known from a restored backup but not on this device.
   *  Empty when storage is unavailable. */
  async refs(): Promise<StoredRef[]> {
    try { return await (await this.store).refs(); } catch { return []; }
  }

  /** Forgets a reference, and its done mark with it. */
  async removeRef(sha: string): Promise<void> {
    await (await this.store).removeRef(sha);
    this.emit('change', undefined);
  }

  /** The ride log, newest first. Empty when storage is unavailable. */
  async rides(): Promise<RideLogEntry[]> {
    try { return await (await this.store).rides(); } catch { return []; }
  }

  /** Logs a finished ride. Never throws: a ride log that cannot be written
   *  must not get in the way of the summary. */
  async logRide(entry: RideLogEntry): Promise<boolean> {
    try {
      const store = await this.store;
      if (!store.available) return false;
      await store.logRide(entry);
      this.emit('change', undefined);
      return true;
    } catch {
      return false;
    }
  }

  /** Links a logged ride to its Strava activity. Never throws. */
  async setRideStrava(startedAt: number, activityId: number): Promise<void> {
    try {
      await (await this.store).setRideStrava(startedAt, activityId);
      this.emit('change', undefined);
    } catch { /* the link is a convenience */ }
  }

  async removeRide(startedAt: number): Promise<void> {
    await (await this.store).removeRide(startedAt);
    this.emit('change', undefined);
  }

  /** Everything a backup takes from the database: My library as references
   *  (kept files without their bytes, and the references already here), done
   *  marks, the followed plan and the ride log. Throws when storage is
   *  unavailable, so an empty browser never passes for an empty profile. */
  async snapshot(): Promise<StoredProfile> {
    const store = await this.store;
    if (!store.available) throw new Error('this browser is not letting the app store anything');
    const [files, refs, done, followed, rides] = await Promise.all([
      store.list(), store.refs(), store.doneMarks(), store.followed(), store.rides(),
    ]);
    return {
      done,
      ...(followed ? { followed } : {}),
      library: [...files.map(({ bytes: _, ...ref }) => ref), ...refs],
      rides,
    };
  }

  /** Replaces the profile in the database, all or nothing (a restore). */
  async replace(profile: StoredProfile): Promise<void> {
    const store = await this.store;
    if (!store.available) throw new Error('this browser is not letting the app store anything');
    await store.replaceProfile(profile);
    this.emit('change', undefined);
  }

  /** Asks the browser not to evict our storage under pressure. Once, on the
   *  first file kept; a refusal changes nothing but the odds. */
  private persist(): void {
    if (this.askedToPersist) return;
    this.askedToPersist = true;
    void globalThis.navigator?.storage?.persist?.().catch(() => false);
  }
}

function workoutOf(result: LoadResult, fileName: string): StoredWorkout {
  const w = result.workout!;
  return {
    title: w.name && w.name !== UNTITLED_WORKOUT ? w.name : baseName(fileName),
    ...(w.author ? { author: w.author } : {}),
    ...(w.description ? { description: w.description } : {}),
    ...summariseWorkout(w),
  };
}

/** A track with fewer than two GPS points is an indoor ride, not a route. */
function routeOf(result: LoadResult): StoredRoute | undefined {
  try {
    return { name: result.track!.name, ...summariseRoute(result.track!) };
  } catch {
    return undefined;
  }
}
