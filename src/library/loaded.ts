import type { Course } from '../activity/course';
import type { Workout } from '../workout/types';

/** The Library entry a loaded workout or route came from. */
export interface LoadedEntry {
  /** `builtin:<id>`, `catalog:<id>` or `mine:<sha256>` */
  key: string;
  title: string;
  /** the file's content hash; built-in workouts have none */
  sha256?: string;
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

/** What a Library load says the file is: its workout's entry, its route's,
 *  or both for a My library FIT file that is both. */
export interface LoadedEntries {
  workout?: LoadedEntry;
  route?: LoadedEntry;
}

/**
 * Which Library entry each loaded route is, so the ride log can name it.
 * Keyed by the `Course` the course store made, by the same rule as workouts:
 * never copy or rebuild the course between loading and finishing.
 */
const routes = new WeakMap<Course, LoadedEntry>();

export function rememberRoute(course: Course, entry: LoadedEntry): void {
  routes.set(course, entry);
}

export function routeEntryFor(course: Course | undefined): LoadedEntry | undefined {
  return course ? routes.get(course) : undefined;
}
