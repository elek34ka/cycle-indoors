import { IDBFactory } from 'fake-indexeddb';
import { setupDom } from './dom-setup';
const dom = setupDom();

const { check, report, suite, until } = await import('./harness');
const { bootApp } = await import('../src/ui/app');
const { session } = await import('../src/session/session');
const { settings } = await import('../src/core/settings');
const { CatalogClient } = await import('../src/catalog/client');
const { openLibraryStore } = await import('../src/library/db');
const { PersonalLibrary } = await import('../src/library/personal');
const { NO_FILTERS } = await import('../src/library/filter');
const { loadFile } = await import('../src/loaders');

const doc = dom.window.document;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => wait(80);

if (session.snapshot.state === 'running' || session.snapshot.state === 'paused') session.finish();
settings.patch({ libraryFilters: NO_FILTERS, librarySection: 'workouts' });

const SWEETSPOT = `<workout_file><name>Sweet spot</name><workout><SteadyState Duration="1800" Power="0.9"/></workout></workout_file>`;
const OTHER = `<workout_file><name>Something else</name><workout><SteadyState Duration="600" Power="0.6"/></workout></workout_file>`;

/** What another browser kept for sweetspot.zwo, as a restore brings it here: everything but the bytes. */
async function referenceTo(text: string, name: string) {
  const elsewhere = new PersonalLibrary(openLibraryStore(new IDBFactory()));
  const file = new File([text], name);
  await elsewhere.keep(file, await loadFile(file, { ftp: 250 }));
  const { bytes: _, ...ref } = (await elsewhere.entries())[0];
  return ref;
}
const ref = await referenceTo(SWEETSPOT, 'sweetspot.zwo');
const key = `mine:${ref.sha256}`;

const factory = new IDBFactory();
await (await openLibraryStore(factory)).replaceProfile({
  done: [{ key, doneAt: new Date(2026, 4, 2).getTime() }], library: [ref], rides: [],
});
bootApp({ catalog: new CatalogClient('', fetch), store: openLibraryStore(factory) });

const row = () => doc.querySelectorAll<HTMLElement>(`#library-root .lib-list .lib-item[data-key="${key}"]`);
const mineRows = () => Array.from(doc.querySelectorAll<HTMLElement>('#library-root .lib-list .lib-item'))
  .filter((r) => r.dataset.key?.startsWith('mine:'));
const drop = (name: string, text: string) => {
  const event = new dom.window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [new File([text], name)] } });
  doc.querySelector('#workout-drop')!.dispatchEvent(event);
};
const store = () => openLibraryStore(factory);

doc.querySelector<HTMLButtonElement>('#tabs [data-tab="library"]')!.click();
await settle();
const shown = row()[0];
shown?.click();
const detail = doc.querySelector('#library-root .lib-detail')!;

suite('shown after restore', () => {
  check('listed in My library', row().length === 1 && shown.querySelector('.lib-title')?.textContent === 'Sweet spot');
  check('greyed, and says it is not on this device', shown.classList.contains('lib-absent')
    && /Not on this device/.test(shown.textContent ?? ''));
  check('with its done mark', shown.querySelector('.lib-done') !== null);
  check('with no Ride control', shown.querySelector('.lib-ride') === null && detail.querySelector('.lib-ride') === null);
  check('the details say how to get it back', /Load sweetspot\.zwo again/.test(detail.textContent ?? ''), detail.textContent ?? '');
  check('and offer Remove', detail.querySelector('.lib-remove') !== null);
});

// A different file with the same name is a different file.
drop('sweetspot.zwo', OTHER);
await until(async () => (await (await store()).list()).length, (n) => n === 1);
doc.querySelector<HTMLButtonElement>('#tabs [data-tab="library"]')!.click();
await settle();
const afterOther = mineRows().map((r) => `${r.querySelector('.lib-title')?.textContent}${r.classList.contains('lib-absent') ? ' (absent)' : ''}`);

suite('a different file with the same name', () => {
  check('is added as a new entry, and the absent one remains',
    afterOther.sort().join() === 'Something else,Sweet spot (absent)', afterOther.join());
});

// The same bytes again: the entry becomes a real one.
drop('sweetspot.zwo', SWEETSPOT);
const files = await until(async () => (await store()).list(), (f) => f.length === 2);
const refsLeft = await (await store()).refs();
doc.querySelector<HTMLButtonElement>('#tabs [data-tab="library"]')!.click();
await settle();
const now = row();

suite('the file loaded again', () => {
  check('is kept with its bytes', files.some((f) => f.sha256 === ref.sha256));
  check('and is no longer a reference', refsLeft.length === 0);
  check('listed once, as a normal entry that can be ridden',
    now.length === 1 && !now[0].classList.contains('lib-absent') && now[0].querySelector('.lib-ride') !== null);
  check('still with its done mark', now[0]?.querySelector('.lib-done') !== null);
});

// Removing an absent entry removes the reference and its mark.
const other = await referenceTo(OTHER.replace('Something else', 'Far away'), 'far.zwo');
const farKey = `mine:${other.sha256}`;
const s = await store();
await s.replaceProfile({
  done: [{ key: farKey, doneAt: 1 }],
  library: [...(await s.list()).map(({ bytes: _, ...r }) => r), other],
  rides: [],
});
doc.querySelector<HTMLButtonElement>('#tabs [data-tab="library"]')!.click();
await settle();
doc.querySelector<HTMLElement>(`#library-root .lib-item[data-key="${farKey}"]`)!.click();
doc.querySelector<HTMLButtonElement>('#library-root .lib-detail .lib-remove')!.click();
await settle();
const dialogText = doc.querySelector('.confirm-overlay')?.textContent ?? '';
Array.from(doc.querySelectorAll<HTMLButtonElement>('.confirm-overlay button')).find((b) => b.textContent === 'Remove')!.click();
const refsAfter = await until(async () => (await store()).refs(), (r) => r.length === 0);
const marksAfter = await (await store()).doneMarks();
const filesAfter = await (await store()).list();

suite('removing an entry not on this device', () => {
  check('asks first', /will no longer be listed in My library/.test(dialogText), dialogText);
  check('removes the reference', refsAfter.length === 0);
  check('and its done mark', !marksAfter.some((m) => m.key === farKey));
  check('the kept files are untouched', filesAfter.length === 2);
});

report();
