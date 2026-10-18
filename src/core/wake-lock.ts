/** The slice of the Screen Wake Lock API this module uses, so tests can stub it. */
export interface WakeLockSentinelLike {
  readonly released: boolean;
  addEventListener(type: 'release', listener: () => void): void;
}

export interface WakeLockNavigator {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

export interface WakeLockDocument {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * Keep the display (and with it the machine) awake while the app is visible, so
 * a long ERG block without touching anything does not end with a dark screen.
 * The browser drops the lock whenever the tab is hidden, so it is asked for
 * again each time the page comes back. Without the API this does nothing.
 */
export function keepScreenAwake(nav: WakeLockNavigator, doc: WakeLockDocument): void {
  const api = nav.wakeLock;
  if (!api) return;
  let sentinel: WakeLockSentinelLike | undefined;
  let pending = false;

  const acquire = async (): Promise<void> => {
    if (pending || doc.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return;
    pending = true;
    try {
      sentinel = await api.request('screen');
      sentinel.addEventListener('release', () => { sentinel = undefined; });
    } catch (err) {
      // Refused (battery saver, permissions policy) — the ride works without it.
      console.warn('screen wake lock unavailable', err);
    } finally {
      pending = false;
    }
  };

  doc.addEventListener('visibilitychange', () => { void acquire(); });
  void acquire();
}
