import { IDBFactory } from 'fake-indexeddb';

const { openLibraryStore, UNAVAILABLE_STORE, DB_NAME, DB_VERSION } = await import('../src/library/db');
const { check, report, suite } = await import('./harness');

let clock = 1_000;
const now = () => clock;
const enc = (s: string) => new TextEncoder().encode(s);
const file = (sha256: string, name = `${sha256}.zwo`) => ({ sha256, name, bytes: enc(`bytes of ${sha256}`) });

const factory = new IDBFactory();
const store = await openLibraryStore(factory, now);
const first = await store.save(file('aaa'));
clock = 2_000;
await store.save({ ...file('bbb', 'loop.gpx'), route: { name: 'Loop', distance: 1000, ascent: 10, start: [1, 2], profile: [[0, 1]] } });
clock = 3_000;
const again = await store.save(file('aaa', 'renamed.zwo'));
const listed = await store.list();

// A reload: a new connection to the same database.
const reopened = await openLibraryStore(factory, now);
const afterReload = await reopened.list();
const fetched = await reopened.get('bbb');

suite('files are kept in IndexedDB', () => {
  check('available', store.available);
  check('a new file is added', first === 'added');
  check('the same bytes again only update it', again === 'updated');
  check('kept once', listed.length === 2, String(listed.length));
  check('most recently used first', listed.map((f) => f.sha256).join() === 'aaa,bbb');
  const a = listed[0];
  check('added time kept, last-used moved', a.addedAt === 1_000 && a.lastUsedAt === 3_000);
  check('the first name is kept', a.name === 'aaa.zwo');
  check('bytes come back intact', new TextDecoder().decode(a.bytes) === 'bytes of aaa');
  check('survives a reload', afterReload.length === 2);
  check('summaries survive too', fetched?.route?.name === 'Loop' && fetched.route.profile[0][1] === 1);
});

clock = 4_000;
await reopened.touch('bbb');
await reopened.touch('missing');
const touched = await reopened.list();
await reopened.remove('aaa');
const removed = await reopened.list();

suite('touch and remove', () => {
  check('touch moves a file to the front', touched[0].sha256 === 'bbb' && touched[0].lastUsedAt === 4_000);
  check('touching an unknown file adds nothing', touched.length === 2);
  check('remove deletes it', removed.length === 1 && removed[0].sha256 === 'bbb');
});

const versions = await new Promise<{ version: number; stores: string[] }>((resolve) => {
  const open = factory.open(DB_NAME);
  open.onsuccess = () => {
    const db = open.result;
    resolve({ version: db.version, stores: Array.from(db.objectStoreNames) });
    db.close();
  };
});

suite('one database, versioned for later stores', () => {
  check(`named ${DB_NAME}, version ${DB_VERSION}`, versions.version === 2);
  check('with done, files and plan stores', versions.stores.sort().join() === 'done,files,plan', versions.stores.join());
});

clock = 5_000;
await reopened.setDone('catalog:workout:a', true);
await reopened.setDone('mine:bbb', true);
clock = 6_000;
await reopened.setDone('builtin:quick', true);
await reopened.setDone('builtin:quick', false);
await reopened.setDone('never-marked', false);
const marks = await (await openLibraryStore(factory, now)).doneMarks();
await reopened.remove('bbb');
const marksAfterRemove = await reopened.doneMarks();
const noneFollowed = await reopened.followed();
await reopened.follow('plan:Gravel');
await reopened.follow('plan:GranFondo');
const followedAfterReload = await (await openLibraryStore(factory, now)).followed();
await reopened.follow(undefined);
const followedAfterStop = await reopened.followed();

suite('done marks and the followed plan', () => {
  check('marks survive a new connection', marks.map((m) => m.key).sort().join() === 'catalog:workout:a,mine:bbb',
    marks.map((m) => m.key).join());
  check('with the time they were made', marks.find((m) => m.key === 'catalog:workout:a')?.doneAt === 5_000);
  check('unmarking removes the mark; unmarking nothing is harmless', !marks.some((m) => m.key === 'builtin:quick'));
  check('removing a My library file removes its mark', marksAfterRemove.map((m) => m.key).join() === 'catalog:workout:a');
  check('no plan is followed at first', noneFollowed === undefined);
  check('following another plan replaces it, across a reload', followedAfterReload === 'plan:GranFondo');
  check('stop following clears it', followedAfterStop === undefined);
});

// The owner's browser already has a version 1 database with files in it.
const legacy = new IDBFactory();
await new Promise<void>((resolve) => {
  const open = legacy.open(DB_NAME, 1);
  open.onupgradeneeded = () => {
    open.result.createObjectStore('files', { keyPath: 'sha256' });
    open.result.createObjectStore('plan');
  };
  open.onsuccess = () => {
    const tx = open.result.transaction('files', 'readwrite');
    tx.objectStore('files').put({ sha256: 'old', name: 'old.zwo', bytes: enc('x'), addedAt: 1, lastUsedAt: 1 });
    tx.oncomplete = () => { open.result.close(); resolve(); };
  };
});
const upgraded = await openLibraryStore(legacy, now);
const keptFiles = await upgraded.list();
await upgraded.setDone('mine:old', true);
const upgradedMarks = await upgraded.doneMarks();

suite('upgrading a version 1 database', () => {
  check('opens', upgraded.available);
  check('keeps its files', keptFiles.length === 1 && keptFiles[0].name === 'old.zwo');
  check('and can hold done marks', upgradedMarks.length === 1);
});

/** A factory whose open fails the way a private window's does. */
const failing = {
  open() {
    const req: Record<string, unknown> = {};
    setTimeout(() => { req.error = new DOMException('denied', 'InvalidStateError'); (req.onerror as () => void)?.(); });
    return req;
  },
} as unknown as IDBFactory;
const throwing = { open() { throw new DOMException('denied', 'SecurityError'); } } as unknown as IDBFactory;

const refused = await openLibraryStore(failing);
const thrown = await openLibraryStore(throwing);
const missing = await openLibraryStore(undefined);

suite('storage the browser refuses', () => {
  check('an open that errors gives the unavailable store', refused === UNAVAILABLE_STORE && !refused.available);
  check('an open that throws too', thrown === UNAVAILABLE_STORE);
  check('no IndexedDB at all too', missing === UNAVAILABLE_STORE);
});

const nothing = await UNAVAILABLE_STORE.list();
const saved = await UNAVAILABLE_STORE.save(file('x'));
await UNAVAILABLE_STORE.setDone('x', true);
const noMarks = await UNAVAILABLE_STORE.doneMarks();

suite('the unavailable store is harmless', () => {
  check('lists nothing', nothing.length === 0);
  check('saving reports unavailable', saved === 'unavailable');
  check('marks nothing', noMarks.length === 0);
});

report();
