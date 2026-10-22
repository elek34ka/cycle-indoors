import { setupDom } from './dom-setup';
setupDom();

import { FakeBluetoothDevice, bytes, u16le, u32le } from './fake-gatt';

const { DeviceHub } = await import('../src/devices/hub');
const { Session } = await import('../src/session/session');
const { FtmsTrainer } = await import('../src/devices/ble/ftms');
const { CHARACTERISTIC, SERVICE } = await import('../src/devices/ble/uuids');
const { DISCONNECTED, NO_RESULT } = await import('../src/session/spin-down');
const { parseZwo } = await import('../src/workout/zwo');
const { check, report, suite } = await import('./harness');

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

/** A trainer that advertises spin-down and answers 0x13 0x01 with a 20–35 km/h window. */
const bt = new FakeBluetoothDevice('calibration-trainer', 'Spin Trainer');
const ftms = bt.service(SERVICE.fitnessMachine);
ftms.add(CHARACTERISTIC.indoorBikeData);
ftms.add(CHARACTERISTIC.fitnessMachineStatus);
ftms.add(CHARACTERISTIC.fitnessMachineControlPoint).onWrite = (written) => bytes(
  0x80, written[0], 0x01,
  ...(written[0] === 0x13 && written[1] === 0x01 ? [...u16le(2000), ...u16le(3500)] : []),
);
ftms.add(CHARACTERISTIC.fitnessMachineFeature, bytes(
  ...u32le((1 << 1) | (1 << 14)),
  ...u32le((1 << 3) | (1 << 13) | (1 << 15)),
));

const hub = new DeviceHub();
const trainer = new FtmsTrainer(bt as unknown as BluetoothDevice);
hub.register(trainer);
await trainer.connect();
await wait(60);

const control = bt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineControlPoint)!;
const status = bt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineStatus)!;
const writesSince = (n: number) => control.writes.slice(n).map(hex);
const targetWrites = (sent: string[]) => sent.filter((w) => w.startsWith('05') || w.startsWith('11'));

/** A trainer only applies a target once control is held and it has been
 *  started, so after anything that ends that state the first target must be
 *  preceded by Request Control (00) and Start (07), in that order. */
function handshakeFirst(sent: string[]): boolean {
  const target = sent.findIndex((w) => w.startsWith('05') || w.startsWith('11'));
  const request = sent.indexOf('00');
  const start = sent.indexOf('07');
  return target >= 0 && request >= 0 && request < start && start < target;
}

const ergWorkout = () => parseZwo(
  `<workout_file><name>Steady</name><workout>
     <SteadyState Duration="600" Power="0.80"/>
   </workout></workout_file>`,
  { ftp: 200 },
);

async function rejection(promise: Promise<unknown>): Promise<string> {
  try { await promise; return ''; } catch (err) { return (err as Error).message; }
}

// --- refused mid-ride --------------------------------------------------------
const riding = new Session(hub);
riding.start();
const whileRunning = await rejection(riding.calibrate());
const runningAllowed = riding.canCalibrate;
riding.pause();
const whilePaused = await rejection(riding.calibrate());
riding.finish();
riding.dispose();
await wait(50); // finish() releases the brake without waiting; let that drain

suite('calibration is refused while a ride is in progress', () => {
  check('refused while running', /Finish the ride first/.test(whileRunning), whileRunning || 'resolved');
  check('and not offered', !runningAllowed);
  check('refused while paused', /Finish the ride first/.test(whilePaused), whilePaused || 'resolved');
  check('nothing was started', riding.calibration.phase === 'idle', riding.calibration.phase);
});

// --- a full spin-down, with Start pressed in the middle ----------------------
const session = new Session(hub);
const phases: string[] = [];
session.on('calibration', (c) => phases.push(c.phase));
check('offered when idle', session.canCalibrate);

const beforeCalibrate = control.writes.length;
await session.calibrate();

suite('calibrating sends the spin-down and guides the rider', () => {
  check('0x13 0x01 went out', writesSince(beforeCalibrate).includes('13 01'), writesSince(beforeCalibrate).join(' | '));
  const c = session.calibration;
  check('the rider is asked to speed up, with the window',
    c.phase === 'speedUp' && c.targets?.lowKph === 20 && c.targets?.highKph === 35, JSON.stringify(c));
  check('not offered again while it runs', !session.canCalibrate);
});

session.start();
await wait(700); // longer than the session's 500 ms command throttle
const secondCalibration = await rejection(session.calibrate());

suite('a ride cannot start during calibration', () => {
  check('the session stayed idle', session.snapshot.state === 'idle', session.snapshot.state);
  check('the rider is told why', /Calibration in progress/.test(session.snapshot.message ?? ''),
    session.snapshot.message ?? 'no message');
  check('no target power or simulation reached the trainer',
    targetWrites(writesSince(beforeCalibrate)).length === 0, writesSince(beforeCalibrate).join(' | '));
  check('a second calibration is refused', /already running/.test(secondCalibration), secondCalibration);
});

status.notify(bytes(0x14, 0x04));
const coasting = session.calibration.phase;
status.notify(bytes(0x14, 0x02));
status.notify(bytes(0x14, 0x03));

suite('the result is reported', () => {
  check('stop pedalling moved to coast', coasting === 'coast', coasting);
  check('success ends it', session.calibration.phase === 'succeeded', session.calibration.phase);
  check('every step was announced', phases.join(' ') === 'requesting speedUp coast succeeded', phases.join(' '));
  check('a later error status does not overturn it', session.calibration.phase === 'succeeded',
    session.calibration.phase);
});

session.dismissCalibration();
check('dismissing clears the result', session.calibration.phase === 'idle', session.calibration.phase);

session.loadWorkout(ergWorkout());
const beforeRide = control.writes.length;
session.start();
await wait(100);
suite('a ride can start once calibration is over', () => {
  check('the session is running', session.snapshot.state === 'running', session.snapshot.state);
  check('and the trainer is told its target again', targetWrites(writesSince(beforeRide)).length > 0,
    writesSince(beforeRide).join(' | '));
  check('control and Start are re-sent before the first ERG target', handshakeFirst(writesSince(beforeRide)),
    writesSince(beforeRide).join(' | '));
});
session.finish();
await wait(50); // let the stop drain

const beforeSecondRide = control.writes.length;
session.start();
await wait(700); // the finish just used the 500 ms command throttle
suite('a second ride after Finish puts the trainer back under control', () => {
  check('the session is running', session.snapshot.state === 'running', session.snapshot.state);
  check('control and Start are re-sent before the first ERG target', handshakeFirst(writesSince(beforeSecondRide)),
    writesSince(beforeSecondRide).join(' | '));
});

const beforePause = control.writes.length;
session.pause();
await wait(50);
session.start();
await wait(700);
suite('pausing does not end the controlled period', () => {
  const sent = writesSince(beforePause);
  check('pause releases the brake, resume restores the target, nothing in between',
    sent.join(' | ') === '05 00 00 | 05 b0 00', sent.join(' | '));
});
session.finish();
await wait(50);
session.dispose();

// --- cancel -------------------------------------------------------------------
const cancelling = new Session(hub);
await cancelling.calibrate();
const beforeCancel = control.writes.length;
cancelling.cancelCalibration();
await wait(20);

suite('cancelling sends ignore and clears the row', () => {
  check('0x13 0x02 went out', writesSince(beforeCancel).includes('13 02'), writesSince(beforeCancel).join(' | '));
  check('no calibration in progress', cancelling.calibration.phase === 'idle', cancelling.calibration.phase);
  check('offered again', cancelling.canCalibrate);
});

cancelling.loadWorkout(ergWorkout());
const beforeRideAfterCancel = control.writes.length;
cancelling.start();
await wait(100);
suite('a ride after a cancelled spin-down puts the trainer back under control', () => {
  check('control and Start are re-sent before the first ERG target', handshakeFirst(writesSince(beforeRideAfterCancel)),
    writesSince(beforeRideAfterCancel).join(' | '));
});
cancelling.finish();
await wait(50);
cancelling.dispose();

// --- a trainer that never reports a result ---------------------------------------
const timing = new Session(hub, 150);
await timing.calibrate();
await wait(250);

timing.loadWorkout(ergWorkout());
const beforeRideAfterTimeout = control.writes.length;

suite('a spin-down with no result times out', () => {
  const c = timing.calibration;
  check('it failed', c.phase === 'failed', c.phase);
  check('saying the trainer did not report', c.phase === 'failed' && c.reason === NO_RESULT, JSON.stringify(c));
  timing.start();
  check('and Start works again', timing.snapshot.state === 'running', timing.snapshot.state);
});
await wait(100);
suite('a ride after a timed-out spin-down puts the trainer back under control', () => {
  check('control and Start are re-sent before the first ERG target', handshakeFirst(writesSince(beforeRideAfterTimeout)),
    writesSince(beforeRideAfterTimeout).join(' | '));
});
timing.finish();
await wait(50);
timing.dispose();

// --- the trainer drops mid-spin-down -----------------------------------------------
const dropping = new Session(hub);
await dropping.calibrate();
bt.drop();

suite('a disconnect ends the spin-down', () => {
  const c = dropping.calibration;
  check('it failed', c.phase === 'failed' && c.reason === DISCONNECTED, JSON.stringify(c));
  dropping.start();
  check('and Start works again', dropping.snapshot.state === 'running', dropping.snapshot.state);
  dropping.finish();
});
dropping.dispose();
await wait(1400); // let the reconnect settle before tearing down
await trainer.disconnect();

report();
