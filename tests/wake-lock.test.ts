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

  doc.set('visible');
  await flush();
  // The browser drops the lock when the tab is hidden…
  doc.visibilityState = 'hidden';
  wakeLock.sentinels[0].release();
  doc.set('hidden');
  await flush();
  // …and the app takes it again when the rider comes back.
  doc.set('visible');
  await flush();
  suite('coming back re-acquires it', () => {
    check('a new lock was requested', wakeLock.sentinels.length === 2, String(wakeLock.sentinels.length));
    check('and it is held', wakeLock.sentinels[1].released === false);
  });
}

console.error = realError;
console.warn = realWarn;

report();
