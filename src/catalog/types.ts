/** The published catalog: `index.json` plus raw files under content-hash keys.
 *  Built by `npm run catalog:build` from the gitignored `content/` folder. */

/** Major version of the index format this app understands. A minor bump
 *  (1.1, 1.2...) only adds optional fields; a major bump breaks old apps. */
export const INDEX_MAJOR = 1;
export const INDEX_VERSION = 1;

/** A raw file in the bucket. `key` is `files/<sha256>.<ext>`, so the bytes
 *  behind a key never change and can be cached forever. */
export interface CatalogFile {
  key: string;
  sha256: string;
  size: number;
  ext: string;
}

/** One workout block: [seconds, start, end] as fractions of FTP; start and end
 *  are null in free-ride blocks. Enough to draw the profile without the file. */
export type CompactBlock = [number, number | null, number | null];

export interface WorkoutSummary {
  /** seconds */
  duration: number;
  /** at 100% FTP; free-ride seconds add nothing */
  tss: number;
  /** intensity factor over the ERG seconds */
  if: number;
  /** seconds in each power zone, index 0 = Z1 ... 6 = Z7 */
  zones: number[];
  blocks: CompactBlock[];
}

export interface RouteSummary {
  /** metres */
  distance: number;
  /** metres, smoothed exactly as the ride screen smooths it */
  ascent: number;
  /** [lat, lon] */
  start: [number, number];
  /** at most 200 [distance m, elevation m] points */
  profile: [number, number][];
}

interface EntryBase {
  /** kind + path below the kind's folder, without extension: `workout:vo2/x` */
  id: string;
  /** path below the kind's folder, with extension: `vo2/x.zwo` */
  path: string;
  /** the sub-folders between the kind's folder and the file */
  tags: string[];
}

export interface WorkoutEntry extends EntryBase, WorkoutSummary {
  title: string;
  author?: string;
  description?: string;
  file: CatalogFile;
  /** for a plan's workouts: the plan's id, `plan:<folder>` */
  plan?: string;
  /** for a plan's workouts in a sub-folder: that sub-folder, `Week_1` */
  group?: string;
}

export interface RouteEntry extends EntryBase, RouteSummary {
  name: string;
  file: CatalogFile;
}

export interface PlanTotals {
  workouts: number;
  /** seconds */
  duration: number;
  tss: number;
}

/** A folder of `content/plans/`. Its workouts are ordinary workout entries;
 *  the plan only fixes their order. */
export interface PlanEntry {
  /** `plan:<folder>` */
  id: string;
  /** the folder's name */
  path: string;
  title: string;
  /** workout entry ids, in plan order */
  workouts: string[];
  totals: PlanTotals;
}

export interface CatalogIndex {
  version: number;
  /** ISO timestamp */
  builtAt: string;
  workouts: WorkoutEntry[];
  routes: RouteEntry[];
  plans: PlanEntry[];
}

export type IndexValidation =
  | { ok: true; index: CatalogIndex }
  | { ok: false; reason: 'version' | 'shape'; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function validFile(v: unknown): boolean {
  return isObject(v) && typeof v.key === 'string' && typeof v.sha256 === 'string'
    && typeof v.size === 'number' && typeof v.ext === 'string';
}

function validEntries(list: unknown, kind: string, needsFile: boolean): string | undefined {
  if (!Array.isArray(list)) return `"${kind}s" is not a list`;
  for (const [i, entry] of list.entries()) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !entry.id.startsWith(`${kind}:`)) {
      return `${kind} ${i} has no valid id`;
    }
    if (needsFile && !validFile(entry.file)) return `${entry.id} has no valid file`;
    if (kind === 'plan' && (!Array.isArray(entry.workouts) || entry.workouts.some((w) => typeof w !== 'string'))) {
      return `${entry.id} has no valid workout list`;
    }
  }
  return undefined;
}

/** Checks a fetched `index.json` before the app trusts it. Only the fields the
 *  app relies on to find and fetch entries are checked; summaries are not. */
export function validateIndex(raw: unknown): IndexValidation {
  if (!isObject(raw) || typeof raw.version !== 'number') {
    return { ok: false, reason: 'shape', message: 'The catalog index is not a catalog' };
  }
  const major = Math.floor(raw.version);
  if (major !== INDEX_MAJOR) {
    return {
      ok: false,
      reason: 'version',
      message: major > INDEX_MAJOR
        ? 'The catalog needs a newer version of the app'
        : `The catalog uses an old format (version ${raw.version})`,
    };
  }
  const problem = validEntries(raw.workouts, 'workout', true)
    ?? validEntries(raw.routes, 'route', true)
    ?? validEntries(raw.plans, 'plan', false);
  if (problem) return { ok: false, reason: 'shape', message: `The catalog index is damaged: ${problem}` };
  return { ok: true, index: raw as unknown as CatalogIndex };
}
