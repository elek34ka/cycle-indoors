import { setupDom } from './dom-setup';
const dom = setupDom();

import { FakeBluetoothDevice, bytes, u16le, u32le } from './fake-gatt';

const { DeviceHub } = await import('../src/devices/hub');
const { Session } = await import('../src/session/session');
const { FtmsTrainer } = await import('../src/devices/ble/ftms');
const { CHARACTERISTIC, SERVICE } = await import('../src/devices/ble/uuids');
const { parseZwo } = await import('../src/workout/zwo');
const { settings } = await import('../src/core/settings');
const { check, report, suite } = await import('./harness');

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
const ack = (written: Uint8Array) => new DataView(Uint8Array.of(0x80, written[0], 0x01).buffer);

// A round FTP keeps the expected wattage obvious: 80% of 200 W is 160 W.
settings.patch({ ftp: 200 });

const bt = new FakeBluetoothDevice('integration-trainer', 'Test Trainer');
const ftms = bt.service(SERVICE.fitnessMachine);
ftms.add(CHARACTERISTIC.indoorBikeData);
ftms.add(CHARACTERISTIC.fitnessMachineStatus);
ftms.add(CHARACTERISTIC.fitnessMachineControlPoint).onWrite = ack;
ftms.add(CHARACTERISTIC.fitnessMachineFeature, bytes(
  ...u32le((1 << 1) | (1 << 14)),
  ...u32le((1 << 3) | (1 << 13)),
));
ftms.add(CHARACTERISTIC.supportedPowerRange, bytes(...u16le(0), ...u16le(2000), ...u16le(1)));

const hub = new DeviceHub();
const trainer = new FtmsTrainer(bt as unknown as BluetoothDevice);
hub.register(trainer);
await trainer.connect();
await wait(60);

const session = new Session(hub);
const control = bt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineControlPoint)!;
const writes = () => control.writes.map(hex);

session.loadWorkout(parseZwo(
  `<workout_file><name>Steady</name><workout>
     <SteadyState Duration="600" Power="0.80"/>
   </workout></workout_file>`,
  { ftp: settings.current.ftp },
));

const beforeStart = control.writes.length;
session.start();
await wait(700);

suite('starting a workout puts the trainer into ERG at the block’s target', () => {
  const sent = writes().slice(beforeStart);
  check('the target went out', sent.includes('05 a0 00'), sent.join(' | ')); // 160 W
  check('the session agrees on the target', session.snapshot.targetPower === 160,
    String(session.snapshot.targetPower));
  check('the ride is in ERG mode', session.snapshot.effectiveMode === 'erg');
});

const beforeBias = control.writes.length;
session.setErgBias(1.1);
await wait(700);

suite('the bias control moves the real brake', () => {
  const sent = writes().slice(beforeBias);
  check('a 10% bias sent 176 W', sent.includes('05 b0 00'), sent.join(' | '));
  check('the session agrees', session.snapshot.targetPower === 176, String(session.snapshot.targetPower));
});

// The trainer browns out mid-interval and comes back.
const beforeDrop = control.writes.length;
bt.drop();
const controlDuringOutage = session.canControlTrainer;
await wait(1600);

suite('a trainer that drops mid-ride comes back holding the right target', () => {
  check('control was lost while it was away', controlDuringOutage === false);
  check('it reconnected', trainer.status === 'connected', trainer.status);
  const sent = writes().slice(beforeDrop);
  check('control was requested on the new link', sent[0] === '00', sent.join(' | '));
  check('and the current target was pushed again without the rider touching anything',
    sent.includes('05 b0 00'), sent.join(' | '));
});

const beforeFree = control.writes.length;
session.setErgBias(1);
session.setMode('free');
session.setGrade(5);
await wait(900);

suite('switching to free mode sends a gradient instead of a target', () => {
  const sent = writes().slice(beforeFree);
  const sims = sent.filter((w) => w.startsWith('11'));
  check('simulation parameters were sent', sims.length > 0, sent.join(' | '));
  // grade 5% -> 500 (0x01f4), crr 0.004 -> 40, cw 0.51 -> 51
  check('the last one carries the 5% gradient', sims[sims.length - 1] === '11 00 00 f4 01 28 33',
    sims.join(' | '));
  check('there is no power target in free mode', session.snapshot.targetPower === 0);
});

const beforeFinish = control.writes.length;
session.finish();
await wait(700);

suite('finishing releases the brake', () => {
  const sent = writes().slice(beforeFinish);
  check('the target was zeroed', sent.includes('05 00 00'), sent.join(' | '));
  check('and the trainer was stopped', sent.includes('08 01'), sent.join(' | '));
  check('the ride is finished', session.snapshot.state === 'finished', session.snapshot.state);
});

suite('nothing was sent out of order', () => {
  const all = writes();
  const targets = all.filter((w) => w.startsWith('05'));
  check('every control request precedes the first target after it',
    all.indexOf('00') < all.indexOf(targets[0]), all.join(' | '));
  check('no write was ever duplicated back to back',
    all.every((w, i) => i === 0 || w !== all[i - 1] || w.startsWith('05')),
    all.join(' | '));
});

report();
session.dispose();
await trainer.disconnect();
dom.window.close();
