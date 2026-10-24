import { setupDom } from './dom-setup';
setupDom();

const { Emitter } = await import('../src/core/pubsub');
const { DeviceHub } = await import('../src/devices/hub');
const { Session } = await import('../src/session/session');
const { courseStore } = await import('../src/activity/course-store');
const { settings } = await import('../src/core/settings');
const { parseZwo } = await import('../src/workout/zwo');
const { check, near, report, suite } = await import('./harness');
import type { Device, DeviceStatus, SimulationParams, Telemetry, TrainerControl } from '../src/devices/types';
import type { ActivityTrack, TrackPoint } from '../src/activity/types';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Longer than the session's 500 ms command throttle, so the latest command is out. */
const settle = () => wait(650);

/** A controllable trainer that remembers every command it was sent. */
type Command = { kind: 'power'; watts: number } | { kind: 'grade'; grade: number };
const sent: Command[] = [];
const control: TrainerControl = {
  setTargetPower: async (watts) => { sent.push({ kind: 'power', watts }); },
  setSimulation: async (p: SimulationParams) => { sent.push({ kind: 'grade', grade: p.grade }); },
};
const bus = new Emitter<{ data: Telemetry; status: DeviceStatus }>();
const trainer: Device = {
  id: 'recording-trainer', label: 'Recording trainer', roles: ['trainer', 'power'], transport: 'mock',
  status: 'connected', connect: async () => {}, disconnect: async () => {},
  onTelemetry: (h) => bus.on('data', h), onStatus: (h) => bus.on('status', h), control,
};
const hub = new DeviceHub();
hub.register(trainer);
const feed = setInterval(() => bus.emit('data', { power: 200, speed: 30 }), 50);

const last = () => sent[sent.length - 1];
const lastText = () => JSON.stringify(last());
const sentSince = (mark: number) => sent.slice(mark);

/** A flat-then-climbing route, so the route gradient is unmistakable. */
function hill(name: string): ActivityTrack {
  const points: TrackPoint[] = [];
  for (let d = 0; d <= 5000; d += 10) points.push({ lat: 50 + d / 111320, lon: 19, ele: 100 + d * 0.06, distance: d });
  return { name, source: 'gpx', points, distance: 5000, ascent: 300, descent: 0, hasPower: false, hasHr: false, hasElevation: true };
}

// FTP 220: 1.0 is 220 W, and 60 % of it rounds to 130 W.
settings.patch({ ftp: 220 });
const workout = () => parseZwo(
  `<workout_file><name>Targets</name><workout>
     <SteadyState Duration="60" Power="1.0"/>
     <Ramp Duration="60" PowerLow="0.75" PowerHigh="1.25"/>
     <FreeRide Duration="60"/>
     <SteadyState Duration="60" Power="1.5"/>
     <FreeRide Duration="60"/>
   </workout></workout_file>`,
  { ftp: 220 },
);

const session = new Session(hub);
session.loadWorkout(workout());
session.setErgBias(1.05);
session.start();
await settle();

suite('an ERG block can be overridden in watts', () => {
  check('the block starts at target × bias', session.snapshot.targetPower === 231, String(session.snapshot.targetPower));
});

session.setBlockOverride(250);
await settle();

suite('override of a steady block', () => {
  const s = session.snapshot;
  check('the target is the typed watts', s.targetPower === 250, String(s.targetPower));
  check('the snapshot reports the override', s.blockOverride === 250, String(s.blockOverride));
  check('the trainer was sent 250 W', last().kind === 'power' && (last() as { watts: number }).watts === 250, lastText());
  check('bias is not applied to it', s.ergBias === 1.05 && s.targetPower !== Math.round(250 * 1.05));
  session.nudgeBias(0.01);
  session.setErgBias(1.2);
  check('bias cannot be changed while it is in force', session.snapshot.ergBias === 1.05, String(session.snapshot.ergBias));
  check('so the target stays at the override', session.snapshot.targetPower === 250);
});

suite('override values out of range are refused', () => {
  for (const bad of [10, 3000, Number.NaN, 24, 2001]) {
    check(`${bad} W is refused`, session.setBlockOverride(bad) === false);
  }
  check('and the target in force is kept', session.snapshot.targetPower === 250, String(session.snapshot.targetPower));
  check('25 W and 2000 W are the limits', session.setBlockOverride(25) && session.setBlockOverride(2000));
  session.setBlockOverride(250);
});

session.setBlockOverride(undefined);
await settle();

suite('clearing the override', () => {
  const s = session.snapshot;
  check('returns to target × bias', s.targetPower === 231, String(s.targetPower));
  check('and the snapshot has no override', s.blockOverride === undefined);
  check('the trainer was told', last().kind === 'power' && (last() as { watts: number }).watts === 231, lastText());
});

session.setBlockOverride(250);
session.skipToNextBlock();
await settle();

suite('Next block ends the override', () => {
  const s = session.snapshot;
  check('the ramp is the current block', s.segmentIndex === 1, String(s.segmentIndex));
  check('the override is gone', s.blockOverride === undefined, String(s.blockOverride));
  // a second or so into a ramp that climbs 110 W in 60 s
  near('the ramp\'s own target applies, with bias', s.targetPower, 0.75 * 220 * 1.05, 6);
});

session.setBlockOverride(180);
session.seek(20);
await settle();

suite('override of a ramp', () => {
  const s = session.snapshot;
  check('still in the ramp after +20 s', s.segmentIndex === 1, String(s.segmentIndex));
  check('the ramp is held flat at the override', s.targetPower === 180, String(s.targetPower));
  check('the trainer holds 180 W', last().kind === 'power' && (last() as { watts: number }).watts === 180, lastText());
});

const samplesBeforeOverride = session.snapshot.samples.length;
await wait(2200);
const overrideSamples = session.snapshot.samples.slice(samplesBeforeOverride);

suite('the recorded target is the override', () => {
  check('seconds were recorded', overrideSamples.length >= 2, String(overrideSamples.length));
  check('each carries 180 W', overrideSamples.every((x) => x.targetPower === 180),
    JSON.stringify(overrideSamples.map((x) => x.targetPower)));
});

// +30 s twice from ~22 s into the ramp: the second crosses into the FreeRide.
session.seek(30);
session.seek(30);
await settle();

suite('+30 s across a block boundary ends the override', () => {
  const s = session.snapshot;
  check('the FreeRide block is current', s.segmentIndex === 2 && s.effectiveMode === 'free', `${s.segmentIndex} ${s.effectiveMode}`);
  check('the override is gone', s.blockOverride === undefined);
});

suite('free riding defaults to a gradient', () => {
  const s = session.snapshot;
  check('Grade is the default', s.freeTarget === 'grade');
  check('the trainer is held at a gradient', s.controlMode === 'grade' && last().kind === 'grade', lastText());
  check('no power target is in force', s.targetPower === 0, String(s.targetPower));
});

const gradeSamplesFrom = session.snapshot.samples.length;
await wait(1200);
const gradeSamples = session.snapshot.samples.slice(gradeSamplesFrom);
const freeMark = sent.length;
session.setFreeTarget('power');
await settle();

suite('a FreeRide block ridden at power', () => {
  const s = session.snapshot;
  check('samples while holding a gradient have no target', gradeSamples.length > 0 && gradeSamples.every((x) => x.targetPower === 0),
    JSON.stringify(gradeSamples.map((x) => x.targetPower)));
  check('the first choice of Watts starts at 60 % of FTP (220 W → 130 W)', s.freePower === 130, String(s.freePower));
  check('the trainer is sent 130 W', last().kind === 'power' && (last() as { watts: number }).watts === 130, lastText());
  check('it is in power control while still a free block', s.controlMode === 'power' && s.effectiveMode === 'free');
  check('the Target is the free watts', s.targetPower === 130);
});

session.setFreePower(180);
await settle();

suite('the free watts are the rider\'s', () => {
  const s = session.snapshot;
  check('180 W is in force', s.targetPower === 180, String(s.targetPower));
  check('without bias', s.ergBias === 1.05);
  check('no gradient was sent since Watts was chosen', sentSince(freeMark).every((c) => c.kind === 'power'),
    JSON.stringify(sentSince(freeMark)));
  check('out of range is refused', session.setFreePower(10) === false && session.setFreePower(5000) === false);
  check('and leaves 180 W', session.snapshot.freePower === 180);
});

const freeSamplesFrom = session.snapshot.samples.length;
await wait(1200);
const freeSamples = session.snapshot.samples.slice(freeSamplesFrom);

suite('the recorded target is the free watts', () => {
  check('each second carries 180 W', freeSamples.length > 0 && freeSamples.every((x) => x.targetPower === 180),
    JSON.stringify(freeSamples.map((x) => x.targetPower)));
});

session.skipToNextBlock();
await settle();
const ergBlockTarget = session.snapshot.targetPower;
session.skipToNextBlock();
await settle();

suite('the free target persists across an ERG block', () => {
  check('the ERG block in between used its own target × bias', ergBlockTarget === Math.round(1.5 * 220 * 1.05),
    String(ergBlockTarget));
  const s = session.snapshot;
  check('the second FreeRide block is current', s.segmentIndex === 4, String(s.segmentIndex));
  check('it holds 180 W again', s.targetPower === 180 && last().kind === 'power'
    && (last() as { watts: number }).watts === 180, lastText());
});

session.skipToNextBlock();
await settle();

suite('after the workout ends', () => {
  const s = session.snapshot;
  check('the workout is complete', s.workoutComplete);
  check('the free watts still hold', s.targetPower === 180 && s.controlMode === 'power', `${s.targetPower} ${s.controlMode}`);
});

suite('Follow route is on when a route is loaded', () => {
  check('off with no route', session.snapshot.followCourse === false);
  courseStore.load(hill('First'));
  check('loading a route turns it on', session.snapshot.followCourse === true);
  session.setFollowCourse(false);
  check('the rider can turn it off', session.snapshot.followCourse === false);
  check('and it stays off', session.snapshot.followCourse === false);
  courseStore.load(hill('Second'));
  check('loading another route turns it on again', session.snapshot.followCourse === true);
});

await wait(1500);
session.setFreeTarget('grade');
await settle();

suite('back to Grade follows the route', () => {
  const s = session.snapshot;
  check('the trainer is held at a gradient', s.controlMode === 'grade' && last().kind === 'grade', lastText());
  check('it is the route\'s gradient', s.coursePosition !== undefined
    && Math.abs((last() as { grade: number }).grade - s.coursePosition.gradient) < 0.5,
    `${lastText()} vs ${s.coursePosition?.gradient}`);
  check('and the free watts are remembered', s.freePower === 180);
});

session.setFreeTarget('power');
session.loadWorkout(undefined);
session.start();
await settle();

suite('an open ride at power', () => {
  const s = session.snapshot;
  check('no workout, so free', s.workout === undefined && s.effectiveMode === 'free');
  check('the trainer holds the free watts', s.targetPower === 180 && last().kind === 'power'
    && (last() as { watts: number }).watts === 180, lastText());
});

session.loadWorkout(workout());
session.start();
session.setBlockOverride(260);
session.setMode('free');
await settle();

suite('the Free toggle', () => {
  const s = session.snapshot;
  check('an ERG block with Free selected is free', s.effectiveMode === 'free' && s.segmentIndex === 0);
  check('it holds the free watts, not the override', s.targetPower === 180 && (last() as { watts: number }).watts === 180,
    lastText());
  check('the override does not show outside ERG', s.blockOverride === undefined);
});

suite('loading a workout clears an override', () => {
  session.setMode('erg');
  session.setBlockOverride(260);
  check('set', session.snapshot.blockOverride === 260);
  session.loadWorkout(workout());
  check('gone after a new workout', session.snapshot.blockOverride === undefined);
  session.start();
  session.setBlockOverride(260);
  session.reset();
  check('gone after a reset', session.snapshot.blockOverride === undefined);
});

clearInterval(feed);
session.dispose();
report();
