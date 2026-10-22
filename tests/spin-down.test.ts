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

suite('guiding through the spin-down', () => {
  const coast = run(requested, accepted, signal('stopPedalling'));
  check('stop pedalling moves to coast, keeping the window',
    coast.phase === 'coast' && coast.targets?.lowKph === 20, JSON.stringify(coast));
  check('coasting is active', isActive(coast));
  const early = run(requested, signal('stopPedalling'));
  check('stop pedalling straight from requesting still coasts', early.phase === 'coast', early.phase);
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

suite('things that end it early', () => {
  const refused = run(requested, { type: 'refused', reason: 'spin down failed: opcode not supported' });
  check('a refusal fails with the trainer’s reason',
    refused.phase === 'failed' && /opcode not supported/.test(refused.reason), JSON.stringify(refused));
  const timedOut = run(requested, accepted, { type: 'timeout' });
  check('a timeout fails with no result', timedOut.phase === 'failed' && timedOut.reason === NO_RESULT,
    JSON.stringify(timedOut));
  const dropped = run(requested, accepted, signal('stopPedalling'), { type: 'disconnected' });
  check('a disconnect fails', dropped.phase === 'failed' && dropped.reason === DISCONNECTED, JSON.stringify(dropped));
  const taken = run(requested, accepted, signal('controlLost'));
  check('losing control fails', taken.phase === 'failed' && taken.reason === CONTROL_TAKEN, JSON.stringify(taken));
  check('cancelling returns to idle', run(requested, accepted, { type: 'cancelled' }).phase === 'idle');
  check('a timeout after a result is ignored',
    run(requested, accepted, signal('success'), { type: 'timeout' }).phase === 'succeeded');
  check('cancelling when idle is harmless', run({ type: 'cancelled' }).phase === 'idle');
});

suite('dismissing and retrying', () => {
  check('dismissing a result returns to idle',
    run(requested, accepted, signal('success'), { type: 'dismissed' }).phase === 'idle');
  check('dismissing does not stop a spin-down in progress',
    run(requested, accepted, { type: 'dismissed' }).phase === 'speedUp');
  check('a failure can be retried directly',
    run(requested, { type: 'timeout' }, requested).phase === 'requesting');
});

suite('what the trainer row says', () => {
  check('idle says nothing', describeSpinDown(SPIN_DOWN_IDLE, 30) === '');
  check('requesting', describeSpinDown(run(requested), undefined) === 'Starting calibration…');

  const speedUp = describeSpinDown(run(requested, accepted), 27.6);
  check('speed up past the high target', /Speed up past 35 km\/h/.test(speedUp), speedUp);
  check('with the window', /20–35 km\/h/.test(speedUp), speedUp);
  check('and the live speed', /now 28 km\/h/.test(speedUp), speedUp);

  const fractional = describeSpinDown(run(requested, { type: 'accepted', targets: { lowKph: 19.5, highKph: 34.25 } }), 30);
  check('fractional targets keep one decimal', /past 34\.3 km\/h/.test(fractional) && /19\.5–/.test(fractional), fractional);

  const blind = describeSpinDown(run(requested, { type: 'accepted' }), 22);
  check('no window means no numeric target', /until told to stop/.test(blind) && !/past/.test(blind), blind);
  check('but still the live speed', /now 22 km\/h/.test(blind), blind);

  const coast = describeSpinDown(run(requested, accepted, signal('stopPedalling')), 31);
  check('coast tells the rider to stop pedalling', /Stop pedalling/.test(coast) && /below 20 km\/h/.test(coast), coast);
  check('no live speed when there is none', !/now/.test(describeSpinDown(run(requested, accepted), undefined)));

  check('success', describeSpinDown(run(requested, accepted, signal('success')), 0) === 'Calibration succeeded');
  const failure = describeSpinDown(run(requested, { type: 'timeout' }), 0);
  check('failure gives the reason and suggests trying again',
    failure.includes(NO_RESULT) && /Try again/.test(failure), failure);
});

report();
