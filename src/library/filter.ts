import type { EntrySource, RouteItem, WorkoutItem } from './entries';

export type LibrarySection = 'workouts' | 'routes' | 'plans' | 'rides';

/** What the rider has narrowed the Library to. A null bound is no bound. */
export interface LibraryFilters {
  search: string;
  source: 'all' | EntrySource;
  /** '' for any tag */
  tag: string;
  minMinutes: number | null;
  maxMinutes: number | null;
  minKm: number | null;
  maxKm: number | null;
  minAscent: number | null;
  maxAscent: number | null;
  /** workouts only: whether they are marked done */
  done: DoneFilter;
}

export type DoneFilter = 'any' | 'done' | 'todo';

export const NO_FILTERS: LibraryFilters = {
  search: '',
  source: 'all',
  tag: '',
  minMinutes: null,
  maxMinutes: null,
  minKm: null,
  maxKm: null,
  minAscent: null,
  maxAscent: null,
  done: 'any',
};

/** Whether a workout passes the done filter, given whether it is done. */
export const passesDone = (f: LibraryFilters, done: boolean) =>
  f.done === 'any' || (f.done === 'done') === done;

const within = (value: number, min: number | null, max: number | null) =>
  (min === null || value >= min) && (max === null || value <= max);

/** Case-insensitive match of every word of the search, each anywhere in the
 *  given fields, so "vo2 short" finds a VO2 workout tagged `short`. */
function matches(search: string, fields: (string | undefined)[]): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fields.filter(Boolean).join('\n').toLowerCase();
  return words.every((w) => haystack.includes(w));
}

function common(item: WorkoutItem | RouteItem, f: LibraryFilters): boolean {
  return (f.source === 'all' || item.source === f.source) && (f.tag === '' || item.tags.includes(f.tag));
}

export function filterWorkouts(
  items: WorkoutItem[], f: LibraryFilters, isDone: (key: string) => boolean = () => false,
): WorkoutItem[] {
  return items.filter((w) => common(w, f)
    && matches(f.search, [w.title, w.author, ...w.tags])
    && within(w.duration / 60, f.minMinutes, f.maxMinutes)
    && passesDone(f, isDone(w.key)));
}

export function filterRoutes(items: RouteItem[], f: LibraryFilters): RouteItem[] {
  return items.filter((r) => common(r, f)
    && matches(f.search, [r.name, ...r.tags])
    && within(r.distance / 1000, f.minKm, f.maxKm)
    && within(r.ascent, f.minAscent, f.maxAscent));
}

/** Every tag in use, sorted, for the tag filter. */
export function tagsOf(items: { tags: string[] }[]): string[] {
  return [...new Set(items.flatMap((i) => i.tags))].sort((a, b) => a.localeCompare(b));
}

/** Whether any filter narrows the given section. My rides has no filters. */
export function isFiltered(f: LibraryFilters, section: LibrarySection): boolean {
  if (section === 'rides') return false;
  const base = f.search.trim() !== '' || f.source !== 'all' || f.tag !== '';
  if (section === 'workouts') return base || f.minMinutes !== null || f.maxMinutes !== null || f.done !== 'any';
  if (section === 'routes') return base || [f.minKm, f.maxKm, f.minAscent, f.maxAscent].some((v) => v !== null);
  return f.search.trim() !== '' || f.done !== 'any';
}
