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

suite('free riding defaults to a gradient', () => {
  const s = session.snapshot;
  check('Grade is the default', s.freeTarget === 'grade');
  check('the trainer is held at a gradient', s.controlMode === 'grade' && last().kind === 'grade', lastText());
  check('no power target is in force', s.targetPower === 0, String(s.targetPower));
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

clearInterval(feed);
session.dispose();
report();
