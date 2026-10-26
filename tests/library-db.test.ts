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
  check(`named ${DB_NAME}, version ${DB_VERSION}`, versions.version === 3);
  check('with done, files, plan, refs and rides stores',
    versions.stores.sort().join() === 'done,files,plan,refs,rides', versions.stores.join());
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

// A version 2 database, as every browser that used done marks has.
const v2 = new IDBFactory();
await new Promise<void>((resolve) => {
  const open = v2.open(DB_NAME, 2);
  open.onupgradeneeded = () => {
    open.result.createObjectStore('files', { keyPath: 'sha256' });
    open.result.createObjectStore('plan');
    open.result.createObjectStore('done', { keyPath: 'key' });
  };
  open.onsuccess = () => {
    const tx = open.result.transaction(['files', 'plan', 'done'], 'readwrite');
    tx.objectStore('files').put({ sha256: 'v2', name: 'v2.zwo', bytes: enc('x'), addedAt: 1, lastUsedAt: 1 });
    tx.objectStore('plan').put({ planId: 'plan:Gravel' }, 'followed');
    tx.objectStore('done').put({ key: 'mine:v2', doneAt: 7 });
    tx.oncomplete = () => { open.result.close(); resolve(); };
  };
});
const fromV2 = await openLibraryStore(v2, now);
const v2Files = await fromV2.list();
const v2Plan = await fromV2.followed();
const v2Marks = await fromV2.doneMarks();
const v2Rides = await fromV2.rides();

suite('upgrading a version 2 database', () => {
  check('keeps its files', v2Files.length === 1 && v2Files[0].name === 'v2.zwo');
  check('keeps its followed plan', v2Plan === 'plan:Gravel');
  check('keeps its done marks', v2Marks.length === 1 && v2Marks[0].doneAt === 7);
  check('starts with an empty ride log', v2Rides.length === 0);
});

// The ride log.
const ride = (startedAt: number, extra: object = {}) => ({
  startedAt, duration: 3600, distance: 30_000, avgPower: 200, normalisedPower: 210, tss: 60, ascent: 300, ...extra,
});
const log = await openLibraryStore(new IDBFactory(), now);
await log.logRide(ride(1_000));
await log.logRide(ride(3_000, { workout: { key: 'builtin:quick', title: 'Quick' } }));
await log.logRide(ride(2_000));
await log.logRide(ride(2_000, { tss: 99 }));
await log.setRideStrava(3_000, 42);
await log.setRideStrava(9_999, 43);
await log.logRide(ride(3_000, { workout: { key: 'builtin:quick', title: 'Quick' } }));
const logged = await log.rides();
await log.removeRide(1_000);
const afterRemoveRide = await log.rides();

suite('the ride log', () => {
  check('newest first', logged.map((r) => r.startedAt).join() === '3000,2000,1000', logged.map((r) => r.startedAt).join());
  check('logging the same start again replaces it', logged.length === 3 && logged[1].tss === 99);
  check('keeps what was ridden', logged[0].workout?.key === 'builtin:quick');
  check('a Strava activity is linked, and logging the ride again keeps it', logged[0].stravaActivityId === 42);
  check('linking an unknown ride adds nothing', !logged.some((r) => r.startedAt === 9_999));
  check('a ride can be removed', afterRemoveRide.map((r) => r.startedAt).join() === '3000,2000');
});

// References to files not on this device. Only a restore creates them.
const refFactory = new IDBFactory();
const refStore = await openLibraryStore(refFactory, now);
const refOf = (sha256: string, name = `${sha256}.zwo`) => ({ sha256, name, addedAt: 1, lastUsedAt: 1 });
await refStore.replaceProfile({
  done: [{ key: 'mine:far', doneAt: 5 }, { key: 'mine:gone', doneAt: 6 }],
  library: [refOf('far', 'sweetspot.zwo'), refOf('gone')],
  rides: [],
});
const refsBefore = await refStore.refs();
const arrived = await refStore.save(file('far', 'sweetspot.zwo'));
const refsAfterLoad = await refStore.refs();
const filesAfterLoad = await refStore.list();
await refStore.removeRef('gone');
const refsAfterRemove = await refStore.refs();
const marksAfterRefRemove = await refStore.doneMarks();

suite('references not on this device', () => {
  check('a restored reference without its file is listed', refsBefore.map((r) => r.sha256).sort().join() === 'far,gone');
  check('loading the same file adds it', arrived === 'added' && filesAfterLoad.length === 1);
  check('and the reference goes, so it is listed once', refsAfterLoad.map((r) => r.sha256).join() === 'gone');
  check('its done mark is kept', marksAfterRefRemove.some((m) => m.key === 'mine:far'));
  check('removing a reference removes it and its mark',
    refsAfterRemove.length === 0 && !marksAfterRefRemove.some((m) => m.key === 'mine:gone'));
});

// A restore replaces the whole profile, all or nothing.
const restoreFactory = new IDBFactory();
const local = await openLibraryStore(restoreFactory, now);
await local.save(file('kept', 'kept.zwo'));
await local.save(file('local-only', 'mine.gpx'));
await local.setDone('A', true);
await local.setDone('C', true);
await local.follow('plan:Local');
await local.logRide(ride(1));
await local.logRide(ride(2));
const before = {
  files: (await local.list()).map((f) => f.sha256).sort().join(),
  marks: (await local.doneMarks()).map((m) => m.key).sort().join(),
  rides: (await local.rides()).map((r) => r.startedAt).join(),
  followed: await local.followed(),
};

// A malformed ride (no key) makes the put throw partway: nothing may change.
let threw = false;
try {
  await local.replaceProfile({
    done: [{ key: 'X', doneAt: 1 }], followed: 'plan:Broken', library: [], rides: [ride(9), { tss: 1 } as never],
  });
} catch { threw = true; }
const afterFailed = {
  files: (await local.list()).map((f) => f.sha256).sort().join(),
  marks: (await local.doneMarks()).map((m) => m.key).sort().join(),
  rides: (await local.rides()).map((r) => r.startedAt).join(),
  followed: await local.followed(),
};

await local.replaceProfile({
  done: [{ key: 'A', doneAt: 3_000 }, { key: 'B', doneAt: 2_000 }],
  followed: 'plan:Backup',
  library: [refOf('kept', 'kept.zwo'), refOf('elsewhere', 'far.zwo')],
  rides: [ride(2, { tss: 77 }), ride(3)],
});
const restoredMarks = await local.doneMarks();
const restoredFiles = await local.list();
const restoredRefs = await local.refs();
const restoredRides = await local.rides();
const restoredPlan = await local.followed();
await local.replaceProfile({ done: [], library: [], rides: [] });
const emptied = { files: await local.list(), refs: await local.refs(), plan: await local.followed() };

suite('a restore replaces the profile', () => {
  check('marks are exactly the backup\'s', restoredMarks.map((m) => `${m.key}@${m.doneAt}`).sort().join() === 'A@3000,B@2000',
    restoredMarks.map((m) => `${m.key}@${m.doneAt}`).join());
  check('rides are exactly the backup\'s', restoredRides.map((r) => r.startedAt).join() === '3,2' && restoredRides[1].tss === 77);
  check('the followed plan is the backup\'s', restoredPlan === 'plan:Backup');
  check('a local-only file is deleted', !restoredFiles.some((f) => f.sha256 === 'local-only'));
  check('a referenced file keeps its bytes', new TextDecoder().decode(restoredFiles.find((f) => f.sha256 === 'kept')?.bytes) === 'bytes of kept');
  check('and is not also a reference', !restoredRefs.some((r) => r.sha256 === 'kept'));
  check('a referenced file not here becomes a reference', restoredRefs.map((r) => r.sha256).join() === 'elsewhere');
  check('an empty backup empties the profile, and no plan is followed',
    emptied.files.length === 0 && emptied.refs.length === 0 && emptied.plan === undefined);
});

suite('a restore that fails partway', () => {
  check('reports the failure', threw);
  check('leaves every store as it was', JSON.stringify(afterFailed) === JSON.stringify(before),
    `${JSON.stringify(before)} → ${JSON.stringify(afterFailed)}`);
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
await UNAVAILABLE_STORE.logRide(ride(1));
const noRides = await UNAVAILABLE_STORE.rides();
const noRefs = await UNAVAILABLE_STORE.refs();

suite('the unavailable store is harmless', () => {
  check('lists nothing', nothing.length === 0);
  check('saving reports unavailable', saved === 'unavailable');
  check('marks nothing', noMarks.length === 0);
  check('logs no rides and holds no references', noRides.length === 0 && noRefs.length === 0);
});

report();
