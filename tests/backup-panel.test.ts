import { IDBFactory } from 'fake-indexeddb';
import { setupDom } from './dom-setup';
const dom = setupDom();

const { check, report, suite, until } = await import('./harness');
const { bootApp } = await import('../src/ui/app');
const { session } = await import('../src/session/session');
const { settings } = await import('../src/core/settings');
const { CatalogClient } = await import('../src/catalog/client');
const { openLibraryStore } = await import('../src/library/db');
const { Backup } = await import('../src/backup/backup');
const { VaultClient } = await import('../src/backup/vault');
const { lastGroup } = await import('../src/backup/key');
const { buildBackupPanel, STRAVA_NOTICE } = await import('../src/ui/backup-panel');
const { default: vaultWorker } = await import('../vault/src/index');
type Env = import('../vault/src/index').Env;

const doc = dom.window.document;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => wait(80);

if (session.snapshot.state === 'running' || session.snapshot.state === 'paused') session.finish();

/** The real Worker over an in-memory bucket. */
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
let requests = 0;
const fetchFn = async (url: string, init: RequestInit = {}) => {
  requests++;
  const headers = new Headers(init.headers);
  headers.set('Origin', 'http://localhost:5173');
  return vaultWorker.fetch(new Request(url, { ...init, headers }), env);
};

const factory = new IDBFactory();
const store = await openLibraryStore(factory);
await store.setDone('builtin:quick', true);
await store.logRide({ startedAt: 1, duration: 3600, distance: 30_000, avgPower: 200, normalisedPower: 210, tss: 60, ascent: 0 });
bootApp({
  catalog: new CatalogClient('', fetch),
  store: openLibraryStore(factory),
  backup: (personal) => new Backup({
    vault: new VaultClient('https://vault.example', fetchFn), store: personal, settings, storage: () => localStorage, now: () => Date.now(),
  }),
});

const panel = () => doc.querySelector<HTMLElement>('#backup-panel')!;
const text = () => panel().textContent ?? '';
const press = (label: string, root: ParentNode = panel()) => {
  const b = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((x) => x.textContent === label);
  if (!b) throw new Error(`no "${label}" button in: ${(root as HTMLElement).textContent}`);
  b.click();
};
const dialog = () => doc.querySelector<HTMLElement>('.confirm-overlay');
const type = (selector: string, value: string) => {
  const input = panel().querySelector<HTMLInputElement>(selector)!;
  input.value = value;
};
const toasts = () => Array.from(doc.querySelectorAll('#toasts .toast')).map((t) => t.textContent ?? '');

const startText = text();
const startButtons = Array.from(panel().querySelectorAll('button')).map((b) => b.textContent).join();
press('Create recovery key');
const key = panel().querySelector('.backup-key')?.textContent ?? '';
const shownText = text();
const shownButtons = Array.from(panel().querySelectorAll('button')).map((b) => b.textContent).join();
type('.backup-confirm-input', 'WRONG1');
press('Confirm and back up');
await settle();
const afterWrong = { requests, toast: toasts().at(-1) ?? '', still: panel().querySelector('.backup-key') !== null };
type('.backup-confirm-input', lastGroup(key));
press('Confirm and back up');
await until(() => /Last backed up/.test(text()), (ok) => ok);

suite('creating a key', () => {
  check('with no key: Create, or I have a key', /recovery key only you hold/.test(startText) && startButtons === 'Create recovery key,I have a key',
    startButtons);
  check('a new key is shown with Copy and Download', key.startsWith('ci1-') && /Copy/.test(shownButtons) && /Download \.txt/.test(shownButtons));
  check('with the warning that a lost key cannot be recovered', /Nobody, including this app, can recover it/.test(shownText));
  check('a wrong last group uploads nothing', afterWrong.requests === 0 && /not the last group/.test(afterWrong.toast) && afterWrong.still,
    JSON.stringify(afterWrong));
  check('the right one backs up', requests === 1 && objects.size === 1 && /Last backed up from this browser/.test(text()), text());
  check('key set: Store current profile to cloud, Retrieve profile from cloud, and the rest under a disclosure',
    /Store current profile to cloud/.test(text()) && /Retrieve profile from cloud/.test(text()) && panel().querySelector('details .backup-delete') !== null);
});

// Change things locally, then restore: the warning, then the Strava notice.
await store.setDone('catalog:workout:new', true);
press('Retrieve profile from cloud');
await until(() => dialog(), (d) => d !== null);
const warning = dialog()?.textContent ?? '';
press('Cancel', dialog()!);
await settle();
const marksAfterCancel = (await store.doneMarks()).map((m) => m.key).sort().join();
press('Retrieve profile from cloud');
await until(() => dialog(), (d) => d !== null);
press('Replace', dialog()!);
const notice = await until(() => dialog()?.textContent ?? '', (t) => /Restored/.test(t));
const noticeButtons = Array.from(dialog()?.querySelectorAll('button') ?? []).map((b) => b.textContent).join();
press('OK', dialog()!);
await settle();
const marksAfterRestore = (await store.doneMarks()).map((m) => m.key).sort().join();

suite('restoring', () => {
  check('warns first, naming the backup\'s date and what it holds', /Replace everything on this device\?/.test(warning)
    && /The backup from \d{4}-\d\d-\d\d \d\d:\d\d \(1 done mark, 1 ride, 0 My library files\)/.test(warning), warning);
  check('and that it fully replaces this device\'s data', /fully replace the done marks, followed plan, settings, ride log and My library/.test(warning)
    && /will be lost/.test(warning));
  check('Cancel changes nothing', marksAfterCancel === 'builtin:quick,catalog:workout:new', marksAfterCancel);
  check('Replace makes it exactly the backup\'s', marksAfterRestore === 'builtin:quick', marksAfterRestore);
  check('then says Strava must be connected separately', notice.includes(STRAVA_NOTICE), notice);
  check('as a notice with one button', noticeButtons === 'OK');
  check('which closes', dialog() === null);
});

// Delete and forget, each after asking.
press('Delete backup');
await until(() => dialog(), (d) => d !== null);
const deleteText = dialog()?.textContent ?? '';
press('Delete backup', dialog()!);
await until(() => objects.size, (n) => n === 0);
press('Forget on this device');
await until(() => dialog(), (d) => d !== null);
const forgetText = dialog()?.textContent ?? '';
press('Forget', dialog()!);
await settle();

suite('delete and forget', () => {
  check('delete asks, then removes the backup', /Delete the backup\?/.test(deleteText) && objects.size === 0);
  check('forget asks, saying the key must be saved elsewhere', /Make sure the key is saved/.test(forgetText));
  check('and the panel is back to no key', /Create recovery key/.test(text()));
});

// Entering an existing key, mistyped then right.
press('I have a key');
type('.backup-key-input', `${key.slice(0, -1)}${key.endsWith('0') ? '1' : '0'}`);
const before = requests;
press('Use this key');
await settle();
const typoToast = toasts().at(-1) ?? '';
type('.backup-key-input', key.toLowerCase());
press('Use this key');
await settle();

suite('entering a key', () => {
  check('a typo is refused before any request', /not a valid recovery key/.test(typoToast) && requests === before, typoToast);
  check('the right key, in any case, is set', /Not backed up from this browser yet/.test(text()), text());
});

// No vault configured.
const before2 = requests;
buildBackupPanel(new Backup({ vault: undefined, store: { snapshot: async () => { throw new Error('x'); }, replace: async () => {} }, settings, storage: () => localStorage, now: () => 0 }));
suite('without a backup service', () => {
  check('the panel says backup is unavailable', /Backup is unavailable/.test(text()) && panel().querySelector('button') === null);
  check('and makes no request', requests === before2);
});

localStorage.clear();
report();
