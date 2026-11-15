import { setupDom } from './dom-setup';
setupDom();

const { buildCatalog } = await import('../src/catalog/build');
const { planSync, runSync, INDEX_KEY, FILE_CACHE, INDEX_CACHE } = await import('../src/catalog/sync');
const { check, report, suite } = await import('./harness');

const enc = (s: string) => new TextEncoder().encode(s);
const zwo = (seconds: number) =>
  enc(`<workout_file><name>w</name><workout><SteadyState Duration="${seconds}" Power="0.7"/></workout></workout_file>`);

/** A stand-in bucket that records every call, in order. */
function fakeBucket(failPut?: (key: string) => boolean) {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string; cacheControl: string }>();
  const calls: string[] = [];
  return {
    objects,
    calls,
    async get(key: string) {
      calls.push(`get ${key}`);
      const o = objects.get(key);
      return o ? new TextDecoder().decode(o.bytes) : undefined;
    },
    async put(key: string, bytes: Uint8Array, contentType: string, cacheControl: string) {
      calls.push(`put ${key}`);
      await new Promise((r) => setTimeout(r, 1));
      if (failPut?.(key)) throw new Error(`upload of ${key} refused`);
      objects.set(key, { bytes, contentType, cacheControl });
    },
    async delete(key: string) {
      calls.push(`delete ${key}`);
      objects.delete(key);
    },
  };
}

const v1 = await buildCatalog([{ path: 'workouts/a.zwo', bytes: zwo(600) }, { path: 'workouts/b.zwo', bytes: zwo(900) }],
  new Date('2026-10-25T10:00:00Z'));
const v1Again = await buildCatalog([{ path: 'workouts/a.zwo', bytes: zwo(600) }, { path: 'workouts/b.zwo', bytes: zwo(900) }],
  new Date('2026-10-26T10:00:00Z'));
const edited = await buildCatalog([{ path: 'workouts/a.zwo', bytes: zwo(660) }, { path: 'workouts/b.zwo', bytes: zwo(900) }]);
const removed = await buildCatalog([{ path: 'workouts/a.zwo', bytes: zwo(600) }]);
const keyOf = (b: typeof v1, id: string) => b.index.workouts.find((w) => w.id === id)!.file.key;

const editBucket = fakeBucket();
await runSync(v1, editBucket);
editBucket.calls.length = 0;
await runSync(edited, editBucket);

suite('runSync: an edit uploads, then swaps the index, then deletes', () => {
  const c = editBucket.calls;
  const up = c.indexOf(`put ${keyOf(edited, 'workout:a')}`);
  const idx = c.indexOf(`put ${INDEX_KEY}`);
  const del = c.indexOf(`delete ${keyOf(v1, 'workout:a')}`);
  check('order: new file, index, old file', up >= 0 && up < idx && idx < del, c.join(', '));
  check('bucket holds exactly the new catalog', editBucket.objects.size === 3);
});

const failing = fakeBucket();
await runSync(v1, failing);
const before = new TextDecoder().decode(failing.objects.get(INDEX_KEY)!.bytes);
const many = await buildCatalog(Array.from({ length: 8 }, (_, i) => ({ path: `workouts/w${i}.zwo`, bytes: zwo(100 + i) })));
const badKey = many.index.workouts[3].file.key;
const failingNow = fakeBucket((key) => key === badKey);
failingNow.objects.set(INDEX_KEY, failing.objects.get(INDEX_KEY)!);
let error: Error | undefined;
try { await runSync(many, failingNow, { concurrency: 2 }); } catch (err) { error = err as Error; }

suite('runSync: an upload that fails leaves the old catalog in place', () => {
  check('the sync rejects', error !== undefined && /refused/.test(error.message), error?.message);
  check('the index was never written', !failingNow.calls.includes(`put ${INDEX_KEY}`));
  check('the old index is untouched', new TextDecoder().decode(failingNow.objects.get(INDEX_KEY)!.bytes) === before);
  check('nothing was deleted', !failingNow.calls.some((c) => c.startsWith('delete')));
  check('no new uploads start after the failure', failingNow.calls.filter((c) => c.startsWith('put')).length < 8,
    failingNow.calls.join(', '));
});

const dry = fakeBucket();
const lines: string[] = [];
const dryResult = await runSync(v1, dry, { dryRun: true, log: (l) => lines.push(l) });

suite('runSync --dry-run reads but never writes', () => {
  check('only a read', dry.calls.join() === `get ${INDEX_KEY}`, dry.calls.join(', '));
  check('reports what it would do', lines.filter((l) => l.includes('would upload')).length === 3, lines.join(' | '));
  check('plan returned', dryResult.plan.uploads.length === 2 && dryResult.uploaded === 0);
});

const broken = await buildCatalog([
  { path: 'routes/loop.gpx', bytes: enc('<gpx/>') }, { path: 'routes/loop.fit', bytes: new Uint8Array(4) },
]);
const untouched = fakeBucket();
let buildError: Error | undefined;
try { await runSync(broken, untouched); } catch (err) { buildError = err as Error; }

const garbled = fakeBucket();
garbled.objects.set(INDEX_KEY, { bytes: enc('{"version": 9}'), contentType: 'application/json', cacheControl: '' });
let garbledError: Error | undefined;
try { await runSync(v1, garbled); } catch (err) { garbledError = err as Error; }

suite('runSync refuses to start on a failed build or an unreadable bucket index', () => {
  check('failed build: rejected', buildError !== undefined);
  check('failed build: the bucket is not even read', untouched.calls.length === 0);
  check('newer bucket index: rejected', garbledError !== undefined && /cannot be read/.test(garbledError.message),
    garbledError?.message);
  check('newer bucket index: nothing written', !garbled.calls.some((c) => c.startsWith('put') || c.startsWith('delete')));
});

report();
