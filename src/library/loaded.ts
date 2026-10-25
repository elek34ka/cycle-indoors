import type { Workout } from '../workout/types';

/** The Library entry a loaded workout came from. */
export interface LoadedEntry {
  /** `builtin:<id>`, `catalog:<id>` or `mine:<sha256>` */
  key: string;
  title: string;
}

/**
 * Which Library entry each loaded workout is, so the ride summary can offer
 * to mark it done. Keyed by the parsed `Workout` object itself: any other
 * load hands the session a different object, so a stale association can
 * never be offered, and nothing has to clear it.
 */
const entries = new WeakMap<Workout, LoadedEntry>();

export function rememberEntry(workout: Workout, entry: LoadedEntry): void {
  entries.set(workout, entry);
}

export function entryFor(workout: Workout | undefined): LoadedEntry | undefined {
  return workout ? entries.get(workout) : undefined;
}
