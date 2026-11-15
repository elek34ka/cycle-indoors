import {
  CONTROL_TAKEN, DISCONNECTED, NO_RESULT, SPIN_DOWN_IDLE, TRAINER_ERROR,
  describeSpinDown, isActive, spinDownReduce, type SpinDownEvent, type SpinDownState,
} from '../src/session/spin-down';
import { check, report, suite } from './harness';

const TARGETS = { lowKph: 20, highKph: 35 };

const run = (...events: SpinDownEvent[]): SpinDownState =>
  events.reduce(spinDownReduce, SPIN_DOWN_IDLE);

const requested: SpinDownEvent = { type: 'requested' };
const accepted: SpinDownEvent = { type: 'accepted', targets: TARGETS };
const signal = (s: 'speedUp' | 'stopPedalling' | 'success' | 'error' | 'controlLost'): SpinDownEvent =>
  ({ type: 'signal', signal: s });

suite('starting a spin-down', () => {
  check('idle is not active', !isActive(SPIN_DOWN_IDLE));
  const requesting = run(requested);
  check('a request moves to requesting', requesting.phase === 'requesting', requesting.phase);
  check('requesting is active', isActive(requesting));

  const withTargets = run(requested, accepted);
  check('acceptance asks the rider to speed up',
    withTargets.phase === 'speedUp' && withTargets.targets?.highKph === 35, JSON.stringify(withTargets));
  const withoutTargets = run(requested, { type: 'accepted' });
  check('acceptance without a window still asks to speed up',
    withoutTargets.phase === 'speedUp' && withoutTargets.targets === undefined, JSON.stringify(withoutTargets));

  const overtaken = run(requested, signal('speedUp'), accepted);
  check('a status that overtakes the response still gets the window',
    overtaken.phase === 'speedUp' && overtaken.targets?.lowKph === 20, JSON.stringify(overtaken));

  const again = run(requested, accepted, requested);
  check('a second request mid-spin-down changes nothing', again.phase === 'speedUp', again.phase);
});

suite('results', () => {
  check('success from coast', run(requested, accepted, signal('stopPedalling'), signal('success')).phase === 'succeeded');
  check('success straight from speed-up', run(requested, accepted, signal('success')).phase === 'succeeded');
  const fromCoast = run(requested, accepted, signal('stopPedalling'), signal('error'));
  check('an error from coast fails', fromCoast.phase === 'failed' && fromCoast.reason === TRAINER_ERROR,
    JSON.stringify(fromCoast));
  const fromSpeedUp = run(requested, accepted, signal('error'));
  check('an error from speed-up fails', fromSpeedUp.phase === 'failed', fromSpeedUp.phase);
  check('results are not active', !isActive(run(requested, accepted, signal('success'))));

  const late = run(requested, accepted, signal('success'), signal('error'));
  check('a late status cannot overturn a result', late.phase === 'succeeded', late.phase);
});

report();
