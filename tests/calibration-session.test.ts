import { setupDom } from './dom-setup';
setupDom();

import { FakeBluetoothDevice, bytes, u16le, u32le } from './fake-gatt';

const { DeviceHub } = await import('../src/devices/hub');
const { Session } = await import('../src/session/session');
const { FtmsTrainer } = await import('../src/devices/ble/ftms');
const { CHARACTERISTIC, SERVICE } = await import('../src/devices/ble/uuids');
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

// --- a full spin-down -------------------------------------------------------
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

session.dispose();
await trainer.disconnect();

report();
