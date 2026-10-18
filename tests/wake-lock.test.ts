const { keepScreenAwake } = await import('../src/core/wake-lock');
const { check, report, suite } = await import('./harness');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A page whose visibility the test controls. */
function fakeDocument(state: DocumentVisibilityState = 'visible') {
  const listeners: (() => void)[] = [];
  return {
    visibilityState: state,
    addEventListener: (_: 'visibilitychange', fn: () => void) => { listeners.push(fn); },
    set(next: DocumentVisibilityState) { this.visibilityState = next; listeners.forEach((fn) => fn()); },
  };
}

/** A wake lock API that records requests and lets the test release the lock. */
function fakeWakeLock() {
  const sentinels: { released: boolean; release(): void }[] = [];
  return {
    sentinels,
    request: async (type: 'screen') => {
      if (type !== 'screen') throw new Error('wrong type');
      const releaseListeners: (() => void)[] = [];
      const sentinel = {
        released: false,
        addEventListener: (_: 'release', fn: () => void) => { releaseListeners.push(fn); },
        release() { sentinel.released = true; releaseListeners.forEach((fn) => fn()); },
      };
      sentinels.push(sentinel);
      return sentinel;
    },
  };
}

const errors: unknown[] = [];
const warnings: unknown[] = [];
const realError = console.error;
const realWarn = console.warn;
console.error = (...args: unknown[]) => { errors.push(args); };
console.warn = (...args: unknown[]) => { warnings.push(args); };

{
  const doc = fakeDocument('visible');
  const wakeLock = fakeWakeLock();
  keepScreenAwake({ wakeLock }, doc);
  await flush();

  suite('the screen is kept awake while the app is visible', () => {
    check('a screen lock is requested on start', wakeLock.sentinels.length === 1, String(wakeLock.sentinels.length));
  });

  doc.set('visible');
  await flush();
  suite('it does not stack locks', () => {
    check('a visibility event with the lock held asks for nothing more', wakeLock.sentinels.length === 1);
  });

  // The browser drops the lock when the tab is hidden…
  doc.visibilityState = 'hidden';
  wakeLock.sentinels[0].release();
  doc.set('hidden');
  await flush();
  suite('while hidden it waits', () => {
    check('no lock is requested for a hidden page', wakeLock.sentinels.length === 1);
  });

  // …and the app takes it again when the rider comes back.
  doc.set('visible');
  await flush();
  suite('coming back re-acquires it', () => {
    check('a new lock was requested', wakeLock.sentinels.length === 2, String(wakeLock.sentinels.length));
    check('and it is held', wakeLock.sentinels[1].released === false);
  });
}

{
  const doc = fakeDocument('hidden');
  const wakeLock = fakeWakeLock();
  keepScreenAwake({ wakeLock }, doc);
  await flush();
  suite('an app opened in a background tab', () => {
    check('asks for nothing until it is shown', wakeLock.sentinels.length === 0);
  });
  doc.set('visible');
  await flush();
  check('and asks once it is', wakeLock.sentinels.length === 1);
}

suite('without the API', () => {
  let threw = false;
  try { keepScreenAwake({}, fakeDocument()); } catch { threw = true; }
  check('nothing happens and nothing throws', !threw);
});

{
  const doc = fakeDocument('visible');
  const api = {
    rejected: 0,
    request: async (): Promise<never> => { api.rejected++; throw new Error('NotAllowedError'); },
  };
  let threw = false;
  try { keepScreenAwake({ wakeLock: api }, doc); } catch { threw = true; }
  await flush();
  doc.set('visible');
  await flush();
  suite('a refused request', () => {
    check('does not throw', !threw);
    check('is tried again on the next visibility change', api.rejected === 2, String(api.rejected));
    check('is only a warning', warnings.length === 2, String(warnings.length));
  });
}

console.error = realError;
console.warn = realWarn;

suite('no errors were logged', () => {
  check('console.error was never called', errors.length === 0, JSON.stringify(errors));
});

report();
