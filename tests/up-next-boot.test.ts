import { IDBFactory } from 'fake-indexeddb';
import { setupDom } from './dom-setup';
const dom = setupDom();

const { check, report, suite } = await import('./harness');
const { bootApp } = await import('../src/ui/app');
const { session } = await import('../src/session/session');
const { CatalogClient } = await import('../src/catalog/client');
const { openLibraryStore } = await import('../src/library/db');

const doc = dom.window.document;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

if (session.snapshot.state === 'running' || session.snapshot.state === 'paused') session.finish();
session.reset();

// A rider who follows a plan, on a network where the catalog never answers.
const factory = new IDBFactory();
await (await openLibraryStore(factory)).follow('plan:Base_Builder');
const requests: string[] = [];
const hanging = (url: string) => { requests.push(url); return new Promise<Response>(() => {}); };
bootApp({ catalog: new CatalogClient('https://pub-test.r2.dev', hanging), store: openLibraryStore(factory) });

const bootedWith = doc.querySelector('#workout-meta h3')?.textContent;
await wait(80);
const upNext = doc.querySelector<HTMLElement>('#up-next')!;

suite('following a plan never holds up boot', () => {
  check('the ride screen boots with the first built-in workout', bootedWith === 'Quick test', bootedWith ?? '');
  check('the index is fetched in the background because a plan is followed', requests.some((u) => u.endsWith('index.json')));
  check('Up next says it is loading meanwhile', !upNext.hidden && /loading the plan/.test(upNext.textContent ?? ''), upNext.textContent ?? '');
  check('the ride can still start', (() => { session.start(); const ok = session.snapshot.state === 'running'; session.finish(); session.reset(); return ok; })());
});

report();
