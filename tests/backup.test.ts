import { IDBFactory } from 'fake-indexeddb';
import { setupDom } from './dom-setup';
setupDom();

const { default: vaultWorker } = await import('../vault/src/index');
const { Backup, BACKUP_STORAGE_KEY, WrongConfirmation } = await import('../src/backup/backup');
const { VaultClient } = await import('../src/backup/vault');
const { BackupDamaged } = await import('../src/backup/seal');
const { InvalidKey, lastGroup } = await import('../src/backup/key');
const { openLibraryStore } = await import('../src/library/db');
const { PersonalLibrary } = await import('../src/library/personal');
const { settings } = await import('../src/core/settings');
const { check, report, suite } = await import('./harness');
type Settings = import('../src/core/settings').Settings;
type Env = import('../vault/src/index').Env;
type Profile = import('../src/backup/profile').Profile;

/** The real Worker, over an in-memory bucket, reached through a stand-in fetch
 *  that adds the Origin a browser would. */
const objects = new Map<string, Uint8Array>();
const unlimited = { limit: async () => ({ success: true }) };
const env: Env = {
  VAULT: {
    async get(key) { const b = objects.get(key); return b ? { arrayBuffer: async () => b.slice().buffer, uploaded: new Date() } : null; },
    async put(key, value) { objects.set(key, new Uint8Array(value)); return { uploaded: new Date() }; },
    async delete(key) { objects.delete(key); },
  },
  WRITE_LIMITER: unlimited, READ_LIMITER: unlimited, APP_ORIGINS: 'http://localhost:5173',
};
const requests: { method: string; body?: string }[] = [];
const fetchFn = async (url: string, init: RequestInit = {}) => {
  requests.push({ method: init.method ?? 'GET', ...(init.body ? { body: new TextDecoder('latin1').decode(init.body as Uint8Array) } : {}) });
  const headers = new Headers(init.headers);
  headers.set('Origin', 'http://localhost:5173');
  return vaultWorker.fetch(new Request(url, { ...init, headers }), env);
};
const puts = () => requests.filter((r) => r.method === 'PUT').length;

/** A browser: its own IndexedDB, settings and localStorage. */
function browser(storage: Storage, start: Partial<Settings> = {}) {
  const factory = new IDBFactory();
  const personal = new PersonalLibrary(openLibraryStore(factory));
  const held = { current: { ...settings.current, ...start } as Settings, patch(v: Partial<Settings>) { held.current = { ...held.current, ...v }; } };
  let clock = 1_000;
  const backup = new Backup({
    vault: new VaultClient('https://vault.example', fetchFn), store: personal, settings: held, storage: () => storage, now: () => clock++,
  });
  return { factory, personal, held, backup, store: () => openLibraryStore(factory) };
}
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k),
    clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; },
  };
}
const enc = (s: string) => new TextEncoder().encode(s);
const ride = (startedAt: number) => ({ startedAt, duration: 3600, distance: 30_000, avgPower: 200, normalisedPower: 210, tss: 60, ascent: 0 });
const caught = async (run: () => Promise<unknown> | unknown) => { try { await run(); return undefined; } catch (e) { return e; } };
const never = { confirm: async () => { throw new Error('asked'); }, restored: async () => { throw new Error('told'); } };

// Browser A uses the page's real localStorage, which settings use too.
const A = browser(localStorage, { ftp: 280, debugMode: true });
const a = await A.store();
await a.save({ sha256: 'laptop-file', name: 'sweetspot.zwo', bytes: enc('zwo bytes') });
await a.setDone('catalog:workout:a', true);
await a.follow('plan:Gravel');
await a.logRide(ride(1));
await a.logRide(ride(2));

const shown = A.backup.newKey();
const notYet = A.backup.key;
const wrong = await caught(() => A.backup.confirmNewKey('ZZZZZZ'));
const putsAfterWrong = puts();
await A.backup.confirmNewKey(lastGroup(shown).toLowerCase());
const stored = [...objects.values()][0];

suite('a new key', () => {
  check('is shown before it is kept', shown.startsWith('ci1-') && notYet === undefined);
  check('a wrong confirmation uploads nothing', wrong instanceof WrongConfirmation && putsAfterWrong === 0);
  check('the right one (any case) keeps the key and makes the first backup', A.backup.key === shown && puts() === 1
    && A.backup.backedUpAt !== undefined);
  check('the vault holds ciphertext only', stored !== undefined
    && !/sweetspot|Gravel|catalog:|"ftp"/.test(new TextDecoder('latin1').decode(stored)));
  check('no request carries the key', !requests.some((r) => r.body?.includes(shown.slice(4, 20))));
});

settings.reset();
const afterReset = A.backup.key;
const enterTypo = await caught(() => browser(memoryStorage()).backup.enterKey(shown.replace(/.$/, (c) => (c === '0' ? '1' : '0'))));
const requestsBeforeTypo = requests.length;

suite('remembering the key', () => {
  check('Reset to defaults keeps it', afterReset === shown);
  check('it lives under its own key', localStorage.getItem(BACKUP_STORAGE_KEY)?.includes(shown) === true);
  check('a mistyped key is refused before any request', enterTypo instanceof InvalidKey && requests.length === requestsBeforeTypo);
});

// Browser B: other data of its own, a tablet's device settings, Strava connected.
const bStorage = memoryStorage();
bStorage.setItem('cycle-indoors.strava.v1', '{"refresh_token":"tablet"}');
const B = browser(bStorage, { ftp: 200, debugMode: false, miniMapPosition: { left: 9, top: 9 } });
const b = await B.store();
await b.save({ sha256: 'tablet-file', name: 'own.gpx', bytes: enc('gpx') });
await b.setDone('builtin:own', true);
await b.logRide(ride(99));
B.backup.enterKey(shown.toLowerCase().replace(/-/g, ''));

let warnedWith: Profile | undefined;
let told = false;
const cancelled = await B.backup.restore({ confirm: async (p) => { warnedWith = p; return false; }, restored: async () => { told = true; } });
const bAfterCancel = (await (await B.store()).doneMarks()).map((m) => m.key).join();
const toldAfterCancel = told;
const outcome = await B.backup.restore({ confirm: async () => true, restored: async () => { told = true; } });
const bMarks = (await b.doneMarks()).map((m) => m.key).join();
const bRides = (await b.rides()).map((r) => r.startedAt).join();
const bFiles = (await b.list()).map((f) => f.sha256).join();
const bRefs = (await b.refs()).map((f) => f.sha256).join();
const bPlan = await b.followed();

suite('restoring in another browser', () => {
  check('the same key typed differently works', B.backup.key === shown);
  check('the warning comes first, with the backup\'s date', cancelled === 'cancelled' && warnedWith?.madeAt !== undefined);
  check('Cancel changes nothing, and says nothing about Strava', bAfterCancel === 'builtin:own' && !toldAfterCancel);
  check('Replace restores', outcome === 'restored');
  check('marks are exactly the backup\'s', bMarks === 'catalog:workout:a', bMarks);
  check('rides are exactly the backup\'s', bRides === '2,1', bRides);
  check('the followed plan is the backup\'s', bPlan === 'plan:Gravel');
  check('this browser\'s own file is gone', bFiles === '', bFiles);
  check('the backup\'s file is not on this device', bRefs === 'laptop-file', bRefs);
  check('personal settings come over', B.held.current.ftp === 280);
  check('device settings stay', B.held.current.debugMode === false && B.held.current.miniMapPosition?.left === 9);
  check('Strava stays connected as it was', bStorage.getItem('cycle-indoors.strava.v1') === '{"refresh_token":"tablet"}');
  check('and the rider is told to connect Strava separately', told);
});

// The last backup wins: B backs up, A restores B's.
await b.setDone('catalog:workout:from-tablet', true);
await B.backup.backUp();
await A.backup.restore({ confirm: async () => true, restored: async () => {} });
const aMarks = (await a.doneMarks()).map((m) => m.key).sort().join();

suite('the last backup wins', () => {
  check('B\'s backup replaced A\'s, with no prompt', aMarks === 'catalog:workout:a,catalog:workout:from-tablet', aMarks);
  check('still one backup in the vault', objects.size === 1);
});

// A key with no backup.
const C = browser(memoryStorage());
C.backup.newKey();
C.backup.enterKey(C.backup.newKey());
const none = await C.backup.restore(never);

// A tampered backup changes nothing.
const slot = [...objects.keys()][0];
const bent = objects.get(slot)!.slice();
bent[40] ^= 1;
objects.set(slot, bent);
const marksBefore = (await a.doneMarks()).map((m) => m.key).join();
const damaged = await caught(() => A.backup.restore(never));
const marksAfter = (await a.doneMarks()).map((m) => m.key).join();

// A corrupt remembered key reads as none.
const D = browser(memoryStorage());
const dStorage = memoryStorage();
dStorage.setItem(BACKUP_STORAGE_KEY, '{"key":"ci1-not-a-key"}');
const corrupt = new Backup({ vault: undefined, store: D.personal, settings: D.held, storage: () => dStorage, now: () => 0 });
const garbled = new Backup({ vault: undefined, store: D.personal, settings: D.held, storage: () => { const s = memoryStorage(); s.setItem(BACKUP_STORAGE_KEY, '{oops'); return s; }, now: () => 0 });

suite('when restore cannot', () => {
  check('a key with no backup: none, and no warning', none === 'none');
  check('a tampered backup is damaged', damaged instanceof BackupDamaged);
  check('and nothing local changes', marksBefore === marksAfter);
  check('a stored key that does not parse reads as no key', corrupt.key === undefined && garbled.key === undefined);
  check('no vault configured: unavailable', !corrupt.available);
});

// Delete, then nothing to restore; forget keeps the backup.
await A.backup.deleteBackup();
const afterDelete = await B.backup.restore(never);
await A.backup.backUp();
A.backup.forget();
const forgotten = A.backup.key;
const stillThere = await B.backup.restore({ confirm: async () => false, restored: async () => {} });

suite('delete and forget', () => {
  check('after Delete, restoring with that key reports no backup', afterDelete === 'none');
  check('Forget removes the key from this browser', forgotten === undefined && localStorage.getItem(BACKUP_STORAGE_KEY) === null);
  check('but the backup stays for other browsers', stillThere === 'cancelled');
});

report();
