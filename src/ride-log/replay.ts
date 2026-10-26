import type { RideLogEntry } from '../library/db';
import type { RouteItem, WorkoutItem } from '../library/entries';

/** What a logged ride's workout or route is in today's Library. */
export type Found<T> =
  | { status: 'found'; item: T }
  /** listed, but its file is not on this device (a restored backup) */
  | { status: 'absent'; item: T }
  /** not found yet, and the catalog is still loading */
  | { status: 'pending' }
  | { status: 'missing' };

/** A logged ride's workout or route reference. */
export interface EntryRef {
  key?: string;
  sha256?: string;
}

/** The content hash of an entry's file, when there is one: built-in
 *  workouts have no file. */
export function entryHash(item: WorkoutItem | RouteItem): string | undefined {
  return item.source === 'mine' ? item.id : item.file?.sha256;
}

/** A reference's hash: its own, or the one a My library key is made of, so
 *  rides logged before hashes were kept still match by content. */
function refHash(ref: EntryRef): string | undefined {
  return ref.sha256 ?? (ref.key?.startsWith('mine:') ? ref.key.slice('mine:'.length) : undefined);
}

/**
 * Finds a logged ride's workout or route among today's entries: by its
 * Library key, else by its file's content hash, so a renamed catalog file or
 * the same bytes kept in My library still count. An entry that can be
 * ridden wins over one that is only listed.
 */
export function findEntry<T extends WorkoutItem | RouteItem>(ref: EntryRef, items: T[], catalogReady: boolean): Found<T> {
  const hash = refHash(ref);
  const matches = items.filter((x) => (ref.key !== undefined && x.key === ref.key) || (hash !== undefined && entryHash(x) === hash));
  const usable = matches.find((x) => !x.absent);
  if (usable) return { status: 'found', item: usable };
  // A catalog entry, or any file by hash, may yet turn up in the catalog.
  if (!catalogReady && (ref.key?.startsWith('catalog:') || hash !== undefined)) return { status: 'pending' };
  if (matches[0]) return { status: 'absent', item: matches[0] };
  return { status: 'missing' };
}

export interface Replay {
  workout?: Found<WorkoutItem>;
  route?: Found<RouteItem>;
  /** every part the ride had is here to ride again; a free ride has none */
  ready: boolean;
}

/** What Ride same session would load for a logged ride. */
export function replayOf(ride: RideLogEntry, workouts: WorkoutItem[], routes: RouteItem[], catalogReady: boolean): Replay {
  const workout = ride.workout ? findEntry(ride.workout, workouts, catalogReady) : undefined;
  const route = ride.route ? findEntry(ride.route, routes, catalogReady) : undefined;
  const parts = [workout, route].filter((p) => p !== undefined);
  return {
    ...(workout ? { workout } : {}),
    ...(route ? { route } : {}),
    ready: parts.length > 0 && parts.every((p) => p.status === 'found'),
  };
}
