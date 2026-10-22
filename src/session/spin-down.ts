import { int } from '../core/format';
import type { SpinDownSignal, SpinDownTargets } from '../devices/types';

/** Where a spin-down calibration has got to. `targets` is the speed window the
 *  trainer asked for, when it said. */
export type SpinDownState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'speedUp'; targets?: SpinDownTargets }
  | { phase: 'coast'; targets?: SpinDownTargets }
  | { phase: 'succeeded' }
  | { phase: 'failed'; reason: string };

export type SpinDownEvent =
  | { type: 'requested' }
  | { type: 'accepted'; targets?: SpinDownTargets }
  | { type: 'refused'; reason: string }
  | { type: 'signal'; signal: SpinDownSignal }
  | { type: 'timeout' }
  | { type: 'disconnected' }
  | { type: 'cancelled' }
  | { type: 'dismissed' };

export const SPIN_DOWN_IDLE: SpinDownState = { phase: 'idle' };

export const NO_RESULT = 'trainer did not report a result';
export const CONTROL_TAKEN = 'the trainer took control back';
export const DISCONNECTED = 'the trainer disconnected';
export const TRAINER_ERROR = 'the trainer reported an error';

/** A spin-down is under way: the trainer is not free for anything else. */
export function isActive(
  state: SpinDownState,
): state is Extract<SpinDownState, { phase: 'requesting' | 'speedUp' | 'coast' }> {
  return state.phase === 'requesting' || state.phase === 'speedUp' || state.phase === 'coast';
}

const failed = (reason: string): SpinDownState => ({ phase: 'failed', reason });

/**
 * One step of the spin-down. Events that make no sense in the current phase
 * leave it unchanged, so a late or duplicated status cannot resurrect a
 * spin-down that has already ended.
 */
export function spinDownReduce(state: SpinDownState, event: SpinDownEvent): SpinDownState {
  if (!isActive(state)) {
    if (event.type === 'requested') return { phase: 'requesting' };
    if (event.type === 'dismissed') return SPIN_DOWN_IDLE;
    return state;
  }

  switch (event.type) {
    case 'requested':
    case 'dismissed':
      return state;
    case 'accepted':
      // A status can overtake the response, so attach the window to whichever
      // guided phase it finds.
      if (state.phase === 'requesting') return { phase: 'speedUp', targets: event.targets };
      if (state.phase === 'speedUp' || state.phase === 'coast') {
        return { ...state, targets: state.targets ?? event.targets };
      }
      return state;
    case 'refused':
      return failed(event.reason);
    case 'timeout':
      return failed(NO_RESULT);
    case 'disconnected':
      return failed(DISCONNECTED);
    case 'cancelled':
      return SPIN_DOWN_IDLE;
    case 'signal':
      switch (event.signal) {
        case 'speedUp':
          return state.phase === 'requesting' ? { phase: 'speedUp' } : state;
        case 'stopPedalling':
          return { phase: 'coast', targets: state.phase === 'requesting' ? undefined : state.targets };
        // Honoured from any active phase: some trainers may never send
        // "stop pedalling" before their result.
        case 'success':
          return { phase: 'succeeded' };
        case 'error':
          return failed(TRAINER_ERROR);
        case 'controlLost':
          return failed(CONTROL_TAKEN);
      }
  }
}

const kph = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

/** What the trainer row says: the step, then the live speed while it matters. */
export function describeSpinDown(state: SpinDownState, liveKph: number | undefined): string {
  const now = liveKph === undefined ? '' : ` · now ${int(liveKph)} km/h`;
  switch (state.phase) {
    case 'idle':
      return '';
    case 'requesting':
      return 'Starting calibration…';
    case 'speedUp': {
      const t = state.targets;
      return t
        ? `Speed up past ${kph(t.highKph)} km/h (window ${kph(t.lowKph)}–${kph(t.highKph)} km/h)${now}`
        : `Speed up until told to stop pedalling${now}`;
    }
    case 'coast': {
      const t = state.targets;
      return t
        ? `Stop pedalling and coast down below ${kph(t.lowKph)} km/h${now}`
        : `Stop pedalling and coast${now}`;
    }
    case 'succeeded':
      return 'Calibration succeeded';
    case 'failed':
      return `Calibration failed: ${state.reason}. Try again.`;
  }
}
