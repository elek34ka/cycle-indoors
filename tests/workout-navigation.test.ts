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

report();
