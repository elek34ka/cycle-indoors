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

localStorage.clear();
report();
