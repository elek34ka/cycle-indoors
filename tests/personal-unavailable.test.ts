import { setupDom } from './dom-setup';
const dom = setupDom();

const { check, report, suite } = await import('./harness');
const { bootApp } = await import('../src/ui/app');
const { session } = await import('../src/session/session');
const { settings } = await import('../src/core/settings');
const { CatalogClient } = await import('../src/catalog/client');
const { UNAVAILABLE_STORE } = await import('../src/library/db');
const { NO_FILTERS } = await import('../src/library/filter');
const { LIBRARY } = await import('../src/workout/library');
const { hideSummary } = await import('../src/ui/summary');

const doc = dom.window.document;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => wait(80);

if (session.snapshot.state === 'running' || session.snapshot.state === 'paused') session.finish();
settings.patch({ libraryFilters: NO_FILTERS, librarySection: 'workouts' });

// A private window: the browser will not give the app any storage.
bootApp({ catalog: new CatalogClient('', fetch), store: Promise.resolve(UNAVAILABLE_STORE) });

const event = new dom.window.Event('drop', { bubbles: true, cancelable: true });
Object.defineProperty(event, 'dataTransfer', {
  value: { files: [new File(['<workout_file><name>Private</name><workout><SteadyState Duration="600" Power="0.7"/></workout></workout_file>'], 'p.zwo')] },
});
doc.querySelector('#workout-drop')!.dispatchEvent(event);
await settle();
const toasts = Array.from(doc.querySelectorAll('#toasts .toast')).map((t) => t.textContent ?? '');

doc.querySelector<HTMLButtonElement>('#tabs [data-tab="library"]')!.click();
await settle();
const mineStatus = doc.querySelector<HTMLElement>('#library-root .lib-mine-status')!;

doc.querySelector<HTMLElement>('#library-root .lib-list .lib-item')!.click();
const toggle = doc.querySelector<HTMLButtonElement>('#library-root .lib-detail .lib-done-toggle')!;
const doneNote = doc.querySelector('#library-root .lib-detail .lib-done-note')?.textContent ?? '';

// The dropped file is loaded but not kept, so there is nothing to mark.
session.start();
await wait(30);
session.finish();
await settle();
const offered = doc.querySelector('#summary-overlay .summary-mark-done') !== null;
hideSummary();
session.reset();

doc.querySelector<HTMLButtonElement>('#tabs [data-tab="library"]')!.click();
await settle();
doc.querySelector<HTMLButtonElement>('#library-root .lib-sections [data-section="rides"]')!.click();
await settle();
const ridesText = doc.querySelector('#library-root .lib-list')?.textContent ?? '';
settings.patch({ librarySection: 'workouts' });

suite('storage the browser will not give', () => {
  check('the file still loads', doc.querySelector('#workout-meta h3')?.textContent === 'Private');
  check('the rider is told it could not be kept', toasts.some((t) => /could not be saved to My library/.test(t)), toasts.join(' | '));
  check('the Library says My library is unavailable', !mineStatus.hidden && /My library is unavailable/.test(mineStatus.textContent ?? ''),
    mineStatus.textContent ?? '');
  check('built-in workouts are still listed', doc.querySelectorAll('#library-root .lib-item').length === LIBRARY.length);
  check('Mark as done is disabled', toggle.disabled);
  check('with the reason shown', /cannot be saved in this browser/.test(doneNote), doneNote);
  check('a file that could not be kept is not offered for marking', !offered);
  check('My rides says the ride log is unavailable', /ride log is unavailable/.test(ridesText), ridesText);
});

report();
