import { setupDom } from './dom-setup';
setupDom();

import { FakeBluetoothDevice, bytes, u16le, u32le } from './fake-gatt';

const { DeviceHub } = await import('../src/devices/hub');
const { Session } = await import('../src/session/session');
const { FtmsTrainer } = await import('../src/devices/ble/ftms');
const { CHARACTERISTIC, SERVICE } = await import('../src/devices/ble/uuids');
const { DISCONNECTED, NO_RESULT } = await import('../src/session/spin-down');
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

const beforeRide = control.writes.length;
session.start();
await wait(100);
suite('a ride can start once calibration is over', () => {
  check('the session is running', session.snapshot.state === 'running', session.snapshot.state);
  check('and the trainer is told its target again', targetWrites(writesSince(beforeRide)).length > 0,
    writesSince(beforeRide).join(' | '));
});
session.finish();
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
cancelling.dispose();

// --- a trainer that never reports a result ---------------------------------------
const timing = new Session(hub, 150);
await timing.calibrate();
await wait(250);

suite('a spin-down with no result times out', () => {
  const c = timing.calibration;
  check('it failed', c.phase === 'failed', c.phase);
  check('saying the trainer did not report', c.phase === 'failed' && c.reason === NO_RESULT, JSON.stringify(c));
  timing.start();
  check('and Start works again', timing.snapshot.state === 'running', timing.snapshot.state);
  timing.finish();
});
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
