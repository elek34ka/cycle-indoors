import { setupDom } from './dom-setup';
const dom = setupDom();

// The rider folded the sidebar away last time.
dom.window.localStorage.setItem('cycle-indoors.settings.v1', JSON.stringify({ showSidebar: false }));

const { check, report, suite } = await import('./harness');
const { bootApp } = await import('../src/ui/app');
const { session } = await import('../src/session/session');

bootApp();
const doc = dom.window.document;

suite('a folded sidebar stays folded after a reload', () => {
  check('the ride view starts without it', doc.querySelector('#view-ride')!.classList.contains('sidebar-hidden'));
  const button = doc.querySelector('#toggle-sidebar');
  check('the toggle offers to show it', button?.getAttribute('aria-pressed') === 'false', button?.outerHTML);
});

report();
session.dispose();
dom.window.close();
