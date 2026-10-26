import { titleInPlan } from '../catalog/names';
import { summariseWorkout } from '../catalog/summary';
import type { CatalogFile, CatalogIndex, PlanEntry, RouteSummary, WorkoutSummary } from '../catalog/types';
import { LIBRARY } from '../workout/library';
import { parseZwo } from '../workout/zwo';
import type { StoredRef } from './db';

/** Where a Library entry comes from. */
export type EntrySource = 'builtin' | 'catalog' | 'mine';

export const SOURCE_LABELS: Record<EntrySource, string> = {
  builtin: 'Built-in',
  catalog: 'Catalog',
  mine: 'My library',
};

interface ItemBase {
  /** unique across sources: `<source>:<id>` */
  key: string;
  source: EntrySource;
  /** the source's own id: a built-in id, or a catalog entry id */
  id: string;
  tags: string[];
  /** for catalog entries, the file to fetch */
  file?: CatalogFile;
  /** the file name to load it as, so the loader picks the right parser */
  fileName?: string;
  /** a My library entry known from a restored backup whose file is not in
   *  this browser: listed, but it cannot be ridden until the file is loaded */
  absent?: boolean;
}

export interface WorkoutItem extends ItemBase, WorkoutSummary {
  title: string;
  author?: string;
  description?: string;
  /** for a plan's workouts: the plan's id and the sub-folder within it */
  plan?: string;
  group?: string;
}

export interface RouteItem extends ItemBase, RouteSummary {
  name: string;
}

const fileNameOf = (path: string) => path.split('/').pop() ?? path;

let builtins: WorkoutItem[] | undefined;

/** The workouts shipped in the bundle, summarised once. Parsed with the
 *  rider's-FTP-independent fractions, so FTP does not matter here. */
export function builtinWorkouts(): WorkoutItem[] {
  builtins ??= LIBRARY.map((entry) => {
    const workout = parseZwo(entry.zwo, { ftp: 250 });
    return {
      key: `builtin:${entry.id}`,
      source: 'builtin',
      id: entry.id,
      tags: [],
      title: entry.title,
      ...(workout.description ? { description: workout.description } : {}),
      ...(workout.author ? { author: workout.author } : {}),
      ...summariseWorkout(workout),
    };
  });
  return builtins;
}

export function catalogWorkouts(index: CatalogIndex | undefined): WorkoutItem[] {
  return (index?.workouts ?? []).map((w) => ({
    ...w,
    // outside the plan's own headings, the week has to be in the title
    title: titleInPlan(w.title, w.group),
    key: `catalog:${w.id}`, source: 'catalog', fileName: fileNameOf(w.path),
  }));
}

export function catalogRoutes(index: CatalogIndex | undefined): RouteItem[] {
  return (index?.routes ?? []).map((r) => ({ ...r, key: `catalog:${r.id}`, source: 'catalog', fileName: fileNameOf(r.path) }));
}

export function catalogPlans(index: CatalogIndex | undefined): PlanEntry[] {
  return index?.plans ?? [];
}

/** My library's workouts: the kept files that are workouts, most recent first. */
export function mineWorkouts(files: StoredRef[], absent = false): WorkoutItem[] {
  return files.filter((f) => f.workout).map((f) => ({
    ...f.workout!, key: `mine:${f.sha256}`, source: 'mine', id: f.sha256, tags: [], fileName: f.name,
    ...(absent ? { absent } : {}),
  }));
}

/** My library's routes. A FIT file that is both is listed in both. */
export function mineRoutes(files: StoredRef[], absent = false): RouteItem[] {
  return files.filter((f) => f.route).map((f) => ({
    ...f.route!, key: `mine:${f.sha256}`, source: 'mine', id: f.sha256, tags: [], fileName: f.name,
    ...(absent ? { absent } : {}),
  }));
}
