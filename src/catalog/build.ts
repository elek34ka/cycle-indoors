import { baseName, loadFile } from '../loaders';
import { UNTITLED_WORKOUT } from '../workout/zwo';
import { sha256 } from './hash';
import { displayName } from './names';
import { summariseRoute, summariseWorkout } from './summary';
import {
  INDEX_VERSION, type CatalogFile, type CatalogIndex, type PlanEntry, type RouteEntry, type WorkoutEntry,
} from './types';

/** A file from `content/`, with its path relative to that folder. */
export interface SourceFile { path: string; bytes: Uint8Array; }

/** A file to publish under its content-hash key. */
export interface BuiltFile { key: string; bytes: Uint8Array; contentType: string; }

/** A file left out of the catalog. Reported, but the build goes on. */
export interface CatalogProblem { path: string; kind: 'skipped' | 'failed'; reason: string; }

export interface CatalogBuild {
  index: CatalogIndex;
  files: BuiltFile[];
  problems: CatalogProblem[];
  /** Faults that fail the build as a whole: nothing may be published. */
  errors: string[];
}

type Kind = 'workout' | 'route';

/** A plan is a folder of `plans/`; its files are workouts. */
const FOLDERS: Record<string, { kind: Kind; exts: string[] }> = {
  workouts: { kind: 'workout', exts: ['zwo', 'fit'] },
  routes: { kind: 'route', exts: ['gpx', 'fit'] },
  plans: { kind: 'workout', exts: ['zwo', 'fit'] },
};

const CONTENT_TYPES: Record<string, string> = {
  zwo: 'application/xml',
  gpx: 'application/gpx+xml',
  fit: 'application/vnd.ant.fit',
};

/** FTP handed to the parsers. Summaries are in fractions of FTP, so it only
 *  matters for the rare file that gives absolute watts. */
const BUILD_FTP = 250;

interface Classified {
  source: SourceFile;
  kind: Kind;
  id: string;
  /** below the kind's folder, with extension */
  path: string;
  name: string;
  ext: string;
  tags: string[];
  /** for a file in a plan folder */
  plan?: { folder: string; group: string[] };
}


const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Natural order, so `_2_` sorts before `_10_` and `Week_2` before
 *  `Week_10`. Code-point order breaks ties, so the result never depends on
 *  the order files were found in. */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * The sequence number a workout title starts with: `Week 1.3 - 1 Min
 * Intervals`, `Phase 2.1 - …`, `1.3 Tempo` → [1, 3]. Many plans number their
 * titles while their file names are in no particular order.
 */
export function titleSequence(title: string): [number, number] | undefined {
  const m = /^\s*(?:[a-z]+\s*)?(\d+)\.(\d+)(?!\d)/i.exec(title);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

type Planned = { c: Classified; entry: WorkoutEntry };

/**
 * Plan order: by sub-folder, segment by segment (a folder's own files before
 * its sub-folders'), then within a folder by the titles' sequence numbers
 * when every title in the plan has one, else by file name. A plan with a few
 * numbered titles among plain ones keeps file order: half a numbering is no
 * order at all.
 */
function sortPlan(items: Planned[]): Planned[] {
  const numbered = items.every((p) => titleSequence(p.entry.title) !== undefined);
  return items.sort((a, b) => {
    const ga = a.c.plan!.group, gb = b.c.plan!.group;
    for (let i = 0; i < Math.min(ga.length, gb.length); i++) {
      const c = naturalCompare(ga[i], gb[i]);
      if (c !== 0) return c;
    }
    if (ga.length !== gb.length) return ga.length - gb.length;
    if (numbered) {
      const [a1, a2] = titleSequence(a.entry.title)!, [b1, b2] = titleSequence(b.entry.title)!;
      if (a1 !== b1 || a2 !== b2) return a1 - b1 || a2 - b2;
    }
    return naturalCompare(a.c.name, b.c.name);
  });
}

function classify(source: SourceFile): Classified | CatalogProblem {
  const parts = source.path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length < 2 || !(parts[0] in FOLDERS)) {
    return { path: source.path, kind: 'skipped', reason: 'not inside workouts/, routes/ or plans/' };
  }
  if (parts[0] === 'plans' && parts.length < 3) {
    return { path: source.path, kind: 'skipped', reason: 'a plan is a folder: put its workouts in plans/<plan name>/' };
  }
  const folder = FOLDERS[parts[0]];
  const name = parts[parts.length - 1];
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (!folder.exts.includes(ext)) {
    return {
      path: source.path,
      kind: 'skipped',
      reason: `${parts[0]}/ takes ${folder.exts.map((e) => `.${e}`).join(' and ')} files`,
    };
  }
  if (parts[0] === 'plans') {
    // `workout:plans/...`, so a plan workout can never take a workouts/ id
    // unnoticed: a clash is reported like any other.
    const path = parts.join('/');
    return {
      source,
      kind: 'workout',
      id: `workout:${path.slice(0, path.length - ext.length - 1)}`,
      path,
      name,
      ext,
      tags: [displayName(parts[1])],
      plan: { folder: parts[1], group: parts.slice(2, -1) },
    };
  }
  const path = parts.slice(1).join('/');
  return {
    source,
    kind: folder.kind,
    id: `${folder.kind}:${path.slice(0, path.length - ext.length - 1)}`,
    path,
    name,
    ext,
    tags: parts.slice(1, -1),
  };
}

/**
 * Turns the files of `content/` into a catalog: the index and the files to
 * publish. Pure apart from hashing, so it runs the same in the suite and in
 * the Node script. Every file is parsed by the app's own loader, so what the
 * index says is what the ride will be.
 */
export async function buildCatalog(sources: SourceFile[], now = new Date()): Promise<CatalogBuild> {
  const problems: CatalogProblem[] = [];
  const errors: string[] = [];

  // Dot-files (.DS_Store, editor swap files) and dot-folders are invisible.
  const visible = sources.filter((s) => !s.path.replace(/\\/g, '/').split('/').some((p) => p.startsWith('.')));

  const byId = new Map<string, Classified[]>();
  for (const source of visible) {
    const c = classify(source);
    if ('reason' in c) { problems.push(c); continue; }
    byId.set(c.id, [...(byId.get(c.id) ?? []), c]);
  }

  const entries: Classified[] = [];
  for (const [id, group] of byId) {
    if (group.length > 1) {
      errors.push(`${id} would come from more than one file: ${group.map((c) => c.source.path).join(', ')}`);
    } else {
      entries.push(group[0]);
    }
  }
  entries.sort((a, b) => naturalCompare(a.id, b.id));

  const files = new Map<string, BuiltFile>();
  const publish = async (c: Classified): Promise<CatalogFile> => {
    const hash = await sha256(c.source.bytes);
    const key = `files/${hash}.${c.ext}`;
    files.set(key, { key, bytes: c.source.bytes, contentType: CONTENT_TYPES[c.ext] ?? 'application/octet-stream' });
    return { key, sha256: hash, size: c.source.bytes.byteLength, ext: c.ext };
  };

  const workouts: WorkoutEntry[] = [];
  const routes: RouteEntry[] = [];
  /** plan folder → the files in it that built */
  const planned = new Map<string, Planned[]>();
  // Every folder of plans/, even one whose files were all skipped, so an
  // empty plan is reported rather than silently missing.
  for (const s of visible) {
    const parts = s.path.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts[0] === 'plans' && parts.length >= 3) planned.set(parts[1], []);
  }

  for (const c of entries) {
    try {
      const loaded = await loadFile(new File([c.source.bytes as BlobPart], c.name), { ftp: BUILD_FTP });
      if (c.kind === 'workout') {
        const workout = loaded.workout;
        if (!workout) throw new Error('has no workout steps — is it a route?');
        const title = workout.name && workout.name !== UNTITLED_WORKOUT ? workout.name : baseName(c.name);
        const entry: WorkoutEntry = {
          id: c.id, path: c.path, tags: c.tags, title,
          ...(workout.author ? { author: workout.author } : {}),
          ...(workout.description ? { description: workout.description } : {}),
          ...summariseWorkout(workout),
          file: await publish(c),
          ...(c.plan ? { plan: `plan:${c.plan.folder}` } : {}),
          ...(c.plan?.group.length ? { group: c.plan.group.join('/') } : {}),
        };
        workouts.push(entry);
        if (c.plan) planned.get(c.plan.folder)?.push({ c, entry });
      } else {
        const track = loaded.track;
        if (!track) throw new Error('has no GPS records — is it a workout?');
        routes.push({ id: c.id, path: c.path, tags: c.tags, name: track.name, ...summariseRoute(track), file: await publish(c) });
      }
    } catch (err) {
      problems.push({ path: c.source.path, kind: 'failed', reason: (err as Error).message });
    }
  }

  const round1 = (v: number) => Math.round(v * 10) / 10;
  const plans: PlanEntry[] = [];
  for (const folder of [...planned.keys()].sort(naturalCompare)) {
    const built = sortPlan(planned.get(folder)!).map((p) => p.entry);
    if (built.length === 0) {
      problems.push({ path: `plans/${folder}/`, kind: 'failed', reason: 'left out: no workout in this plan could be read' });
      continue;
    }
    plans.push({
      id: `plan:${folder}`,
      path: folder,
      title: displayName(folder),
      workouts: built.map((w) => w.id),
      totals: {
        workouts: built.length,
        duration: round1(built.reduce((sum, w) => sum + w.duration, 0)),
        tss: round1(built.reduce((sum, w) => sum + w.tss, 0)),
      },
    });
  }

  return {
    index: { version: INDEX_VERSION, builtAt: now.toISOString(), workouts, routes, plans },
    files: [...files.values()],
    problems,
    errors,
  };
}
