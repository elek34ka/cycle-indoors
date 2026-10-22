import { setupDom } from './dom-setup';
setupDom();

const { DeviceHub } = await import('../src/devices/hub');
const { Session } = await import('../src/session/session');
const { check, report, suite } = await import('./harness');
import type { Segment, Workout } from '../src/workout/types';

const block = (index: number, start: number, duration: number, power: number): Segment => ({
  index, start, duration, powerStart: power, powerEnd: power, mode: 'erg', kind: 'SteadyState', label: 'x',
});

// Twelve five-minute blocks: a 60-minute workout.
const segments = Array.from({ length: 12 }, (_, i) => block(i, i * 300, 300, 0.6));
const workout: Workout = { name: 'nav', duration: 3600, segments, textEvents: [], source: 'zwo' };

// Nothing is connected and the ride never starts, so the clock moves only on
// request and every check below is exact.
const session = new Session(new DeviceHub());
session.loadWorkout(workout);
const clock = () => session.snapshot.elapsed;

suite('the workout clock moves forward on request', () => {
  session.seek(600);
  check('+600 s from the start lands on 10:00', clock() === 600, String(clock()));
  session.seek(30);
  check('+30s from 10:00 lands on 10:30', clock() === 630, String(clock()));
  session.skipToNextBlock();
  check('next block from 10:30 lands on the start of the next block, 15:00', clock() === 900, String(clock()));
  check('the block index advanced', session.snapshot.segmentIndex === 3, String(session.snapshot.segmentIndex));
});

suite('the workout clock never moves backwards on request', () => {
  const before = clock();
  session.seek(-30);
  check('−30 s leaves the clock unchanged', clock() === before, String(clock()));
  session.seek(-1000);
  check('a large backward seek leaves it unchanged too', clock() === before, String(clock()));
  session.seek(0);
  check('a zero seek is no move', clock() === before, String(clock()));
});

suite('forward requests stop at the end of the workout', () => {
  session.seek(3590 - clock());
  check('the clock reads 59:50', clock() === 3590, String(clock()));
  session.seek(30);
  check('+30s at 59:50 lands exactly on 60:00', clock() === 3600, String(clock()));
  session.seek(30);
  check('+30s at the end does nothing', clock() === 3600, String(clock()));
  session.skipToNextBlock();
  check('next block at the end does nothing', clock() === 3600, String(clock()));
});

suite('next block in the last block goes to the end', () => {
  session.loadWorkout(workout);
  session.seek(3400);
  session.skipToNextBlock();
  check('from 56:40 next block lands on 60:00', clock() === 3600, String(clock()));
});

suite('there is no way back once the workout has run out', () => {
  session.loadWorkout(workout);
  session.seek(3600);
  // what the running clock does past the end, without waiting for it
  (session as unknown as { elapsed: number }).elapsed = 3900;
  session.seek(30);
  check('+30s past the end leaves the clock at 65:00', clock() === 3900, String(clock()));
  session.skipToNextBlock();
  check('next block past the end does not step back to 60:00', clock() === 3900, String(clock()));
  session.seek(-600);
  check('nor does a backward seek', clock() === 3900, String(clock()));
});

suite('before the start, skipping forward cannot be undone', () => {
  session.loadWorkout(workout);
  session.skipToNextBlock();
  session.skipToNextBlock();
  check('two presses put the start on the third block', session.snapshot.segmentIndex === 2,
    String(session.snapshot.segmentIndex));
  session.seek(-600);
  check('and there is no going back to the first', clock() === 600, String(clock()));
});

report();
