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

suite('planSync: an empty bucket gets everything', () => {
  const plan = planSync(undefined, v1.index);
  check('both files uploaded', plan.uploads.length === 2);
  check('index written', plan.writeIndex);
  check('nothing deleted', plan.deletes.length === 0);
});

suite('planSync: nothing changed', () => {
  const plan = planSync(v1.index, v1Again.index);
  check('no uploads', plan.uploads.length === 0);
  check('no deletes', plan.deletes.length === 0);
  check('index not rewritten for a new build time alone', !plan.writeIndex);
});

suite('planSync: an edited file', () => {
  const plan = planSync(v1.index, edited.index);
  check('the new key is uploaded', plan.uploads.join() === keyOf(edited, 'workout:a'));
  check('the old key is deleted', plan.deletes.join() === keyOf(v1, 'workout:a'));
  check('the unchanged file is left alone', !plan.uploads.includes(keyOf(v1, 'workout:b'))
    && !plan.deletes.includes(keyOf(v1, 'workout:b')));
  check('index written', plan.writeIndex);
});

suite('planSync: a removed file', () => {
  const plan = planSync(v1.index, removed.index);
  check('nothing to upload', plan.uploads.length === 0);
  check('its key is deleted', plan.deletes.join() === keyOf(v1, 'workout:b'));
  check('index written', plan.writeIndex);
});

suite('planSync: a change to the index alone still writes it', () => {
  const renamed = { ...v1.index, workouts: v1.index.workouts.map((w) => ({ ...w, tags: ['x'] })) };
  check('index written', planSync(v1.index, renamed).writeIndex);
});

const first = fakeBucket();
await runSync(v1, first);
const firstCalls = [...first.calls];
first.calls.length = 0;
await runSync(v1Again, first);
const secondCalls = [...first.calls];

suite('runSync: first sync, then an unchanged one', () => {
  check('files first, index last', firstCalls[firstCalls.length - 1] === `put ${INDEX_KEY}`
    && firstCalls.filter((c) => c.startsWith('put')).length === 3, firstCalls.join(', '));
  const file = first.objects.get(keyOf(v1, 'workout:a'))!;
  check('files cached forever', file.cacheControl === FILE_CACHE && file.contentType === 'application/xml');
  check('index cached for a minute', first.objects.get(INDEX_KEY)?.cacheControl === INDEX_CACHE
    && first.objects.get(INDEX_KEY)?.contentType === 'application/json');
  check('the second sync only reads the index', secondCalls.join() === `get ${INDEX_KEY}`, secondCalls.join(', '));
});

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

const flaky = fakeBucket();
await runSync(v1, flaky);
flaky.delete = async (key: string) => { flaky.calls.push(`delete ${key}`); throw new Error('network'); };
const flakyLines: string[] = [];
const flakyResult = await runSync(removed, flaky, { log: (l) => flakyLines.push(l) });

suite('runSync: a failed delete is reported, not fatal', () => {
  check('the sync completes', flakyResult.deleted === 0 && flakyResult.plan.deletes.length === 1);
  check('the new index is live', JSON.parse(new TextDecoder().decode(flaky.objects.get(INDEX_KEY)!.bytes)).workouts.length === 1);
  check('the leftover is reported', flakyLines.some((l) => l.includes('could not delete')));
});

report();
