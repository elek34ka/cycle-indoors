import { setupDom } from './dom-setup';
setupDom();

import { FakeBluetoothDevice, bytes, text, u16le, u32le } from './fake-gatt';

const { FtmsTrainer } = await import('../src/devices/ble/ftms');
const { BleHeartRateMonitor, BlePowerMeter } = await import('../src/devices/ble/sensors');
const { CHARACTERISTIC, SERVICE } = await import('../src/devices/ble/uuids');
const { check, near, report, suite } = await import('./harness');
import type { Device, Telemetry } from '../src/devices/types';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function collect(device: Device): Telemetry[] {
  const seen: Telemetry[] = [];
  device.onTelemetry((t) => seen.push(t));
  return seen;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
const ack = (bytes: Uint8Array) => bytes2(0x80, bytes[0], 0x01);
const bytes2 = (...values: number[]) => new DataView(Uint8Array.from(values).buffer);

/** A trainer that reports power+cadence+speed and accepts ERG and simulation. */
function buildTrainer(name = 'Elite Suito-T'): FakeBluetoothDevice {
  const bt = new FakeBluetoothDevice('trainer-abc', name);
  const ftms = bt.service(SERVICE.fitnessMachine);
  ftms.add(CHARACTERISTIC.indoorBikeData);
  ftms.add(CHARACTERISTIC.fitnessMachineStatus);
  // Acknowledge every control-point write, as a compliant trainer does.
  ftms.add(CHARACTERISTIC.fitnessMachineControlPoint).onWrite = ack;
  ftms.add(CHARACTERISTIC.fitnessMachineFeature, bytes(
    ...u32le((1 << 1) | (1 << 2) | (1 << 14)),
    ...u32le((1 << 3) | (1 << 13)),
  ));
  ftms.add(CHARACTERISTIC.supportedPowerRange, bytes(...u16le(0), ...u16le(2000), ...u16le(1)));
  bt.service(SERVICE.battery).add(CHARACTERISTIC.batteryLevel, bytes(76));
  const info = bt.service(SERVICE.deviceInformation);
  info.add(CHARACTERISTIC.manufacturerName, text('Elite'));
  info.add(CHARACTERISTIC.modelNumber, text('Suito-T'));
  return bt;
}

const bt = buildTrainer();
const trainer = new FtmsTrainer(bt as unknown as BluetoothDevice);
const seen = collect(trainer);
const statuses: string[] = [];
trainer.onStatus((s) => statuses.push(s));

await trainer.connect();

suite('connecting to an FTMS trainer', () => {
  check('status is connected', trainer.status === 'connected', trainer.status);
  check('it went through "connecting" first', statuses[0] === 'connecting', statuses.join(' → '));
  check('the Indoor Bike Data characteristic was subscribed',
    bt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.indoorBikeData)?.startCalls === 1);
  check('the machine status characteristic was subscribed too',
    bt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineStatus)?.startCalls === 1);
  check('the feature characteristic was read', trainer.features !== undefined);
  check('it reports power', trainer.features!.reports.power);
  check('it accepts a power target', trainer.features!.canSet.power);
  check('it accepts simulation parameters', trainer.features!.canSet.simulation);
  check('the control point was found', trainer.hasControlPoint);
  near('the supported power range was read', trainer.powerRange!.max, 2000, 0.001);
  check('control capability reads as ERG + simulation',
    trainer.describeControl() === 'supports ERG + simulation', trainer.describeControl());
  near('battery level was read', trainer.battery!, 76, 0.001);
  check('manufacturer and model were read',
    trainer.identity.manufacturer === 'Elite' && trainer.identity.model === 'Suito-T',
    JSON.stringify(trainer.identity));
  check('the advertised name is kept as the label', trainer.label === 'Elite Suito-T', trainer.label);
});

bt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.indoorBikeData)!
  .notify(bytes(...u16le(0x0044), ...u16le(3250), ...u16le(176), ...u16le(238)));

suite('telemetry flows from notifications', () => {
  check('one telemetry update arrived', seen.length === 1, String(seen.length));
  near('power', seen[0].power!, 238, 0.001);
  near('cadence', seen[0].cadence!, 88, 0.001);
  near('speed', seen[0].speed!, 32.5, 0.001);
});

bt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineStatus)!.notify(bytes(0x08));

suite('machine status is surfaced', () => {
  check('a target-power change is reported',
    trainer.lastMachineStatus === 'target power changed', trainer.lastMachineStatus ?? 'none');
});

// --- the link drops on its own ---------------------------------------------
const connectsBefore = bt.gatt.connectCalls;
bt.drop();
const statusAfterDrop = trainer.status;
await wait(1400);

suite('an unexpected drop reconnects on its own', () => {
  check('status shows it is trying again', statusAfterDrop === 'connecting', statusAfterDrop);
  check('it reconnected', trainer.status === 'connected', trainer.status);
  check('a fresh GATT connect was made', bt.gatt.connectCalls > connectsBefore,
    `${connectsBefore} → ${bt.gatt.connectCalls}`);
  check('notifications were re-subscribed on the new link',
    (bt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.indoorBikeData)?.startCalls ?? 0) >= 2,
    String(bt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.indoorBikeData)?.startCalls));
});

bt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.indoorBikeData)!
  .notify(bytes(...u16le(0x0041), ...u16le(150)));

suite('data flows again after reconnecting', () => {
  check('exactly one further update arrived', seen.length === 2, String(seen.length));
  near('and it parsed', seen[1].power!, 150, 0.001);
  check('the reconnect did not leave a duplicate listener behind',
    bt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.indoorBikeData)?.listenerCount === 1,
    String(bt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.indoorBikeData)?.listenerCount));
});

// --- trainer control -------------------------------------------------------
const controlChar = bt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineControlPoint)!;
const cpWrites = () => controlChar.writes.map(hex);
await wait(60); // control is requested in the background, not during connect

suite('control is taken on connect', () => {
  check('the trainer offers control', trainer.control !== undefined);
  check('control was requested, then the trainer started',
    cpWrites().slice(0, 2).join(' | ') === '00 | 07', cpWrites().join(' | '));
  check('the panel can say the brake is ours',
    trainer.describeControlState() === 'in control', trainer.describeControlState());
  check('and what the trainer last said',
    trainer.lastControlResult === 'start: success', trainer.lastControlResult ?? 'none');
});

const beforeErg = controlChar.writes.length;
await trainer.control!.setTargetPower(250);
await trainer.control!.setTargetPower(5000);
await trainer.control!.setTargetPower(-100);

suite('ERG targets reach the brake, clamped to what the trainer can do', () => {
  const sent = cpWrites().slice(beforeErg);
  check('250 W went out as a little-endian sint16', sent[0] === '05 fa 00', sent.join(' | '));
  check('an impossible target is clamped to the trainer’s maximum',
    sent[1] === '05 d0 07', sent.join(' | ')); // 2000 W
  check('and a negative one to its minimum', sent[2] === '05 00 00', sent.join(' | '));
  check('no extra control requests were needed',
    !sent.includes('00'), sent.join(' | '));
});

const beforeSim = controlChar.writes.length;
await trainer.control!.setSimulation({ grade: 6, crr: 0.004, cw: 0.51, windSpeed: 0 });

suite('free mode sends simulation parameters', () => {
  // grade 6% -> 600 (0x0258), crr 0.004 -> 40, cw 0.51 -> 51
  check('a 6% gradient went out', cpWrites()[beforeSim] === '11 00 00 58 02 28 33',
    cpWrites()[beforeSim]);
});

// The trainer takes control back — the next command must ask for it again
// rather than failing.
bt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineStatus)!.notify(bytes2(0xff));
const beforeRegain = controlChar.writes.length;
await trainer.control!.setTargetPower(200);

suite('control taken back by the trainer is re-acquired', () => {
  check('the trainer told us it took control back',
    trainer.lastMachineStatus === 'control permission lost', trainer.lastMachineStatus ?? 'none');
  const sent = cpWrites().slice(beforeRegain);
  check('control was requested again', sent[0] === '00', sent.join(' | '));
  check('and the target still went out', sent.includes('05 c8 00'), sent.join(' | '));
});

const beforeStop = controlChar.writes.length;
await trainer.control!.stop!();

suite('finishing releases the brake', () => {
  check('a stop was sent', cpWrites()[beforeStop] === '08 01', cpWrites()[beforeStop]);
});

suite('a trainer that does not advertise spin-down offers no calibration', () => {
  check('no spin-down without feature bit 15', trainer.control!.spinDown === undefined);
});

// --- spin-down calibration -------------------------------------------------
/** A trainer advertising spin-down (target-setting bit 15). Its control point
 *  answers 0x13 with `spinReply` and everything else with success. */
function buildSpinTrainer(id: string, spinReply: (bytes: Uint8Array) => DataView): FakeBluetoothDevice {
  const spinBt = new FakeBluetoothDevice(id, 'Spin Trainer');
  const service = spinBt.service(SERVICE.fitnessMachine);
  service.add(CHARACTERISTIC.indoorBikeData);
  service.add(CHARACTERISTIC.fitnessMachineStatus);
  service.add(CHARACTERISTIC.fitnessMachineControlPoint).onWrite =
    (written) => (written[0] === 0x13 ? spinReply(written) : ack(written));
  service.add(CHARACTERISTIC.fitnessMachineFeature, bytes(
    ...u32le((1 << 1) | (1 << 14)),
    ...u32le((1 << 3) | (1 << 13) | (1 << 15)),
  ));
  return spinBt;
}

const spinBt = buildSpinTrainer('spin-trainer',
  (written) => bytes2(0x80, 0x13, 0x01, ...(written[1] === 0x01 ? [0xd0, 0x07, 0xac, 0x0d] : [])));
const spinTrainer = new FtmsTrainer(spinBt as unknown as BluetoothDevice);
await spinTrainer.connect();
await wait(60);
const spinControl = spinBt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineControlPoint)!;
const spinStatus = spinBt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineStatus)!;
const signals: string[] = [];
spinTrainer.control!.spinDown?.onSignal((signal) => signals.push(signal));

const beforeSpin = spinControl.writes.length;
const targets = await spinTrainer.control!.spinDown!.start();

suite('a spin-down is requested over the control point', () => {
  check('bit 15 makes spin-down available', spinTrainer.control?.spinDown !== undefined);
  const sent = spinControl.writes.map(hex).slice(beforeSpin);
  check('the start went out as 0x13 0x01', sent.includes('13 01'), sent.join(' | '));
  check('control was held first', spinControl.writes.map(hex).indexOf('00') < spinControl.writes.map(hex).indexOf('13 01'),
    spinControl.writes.map(hex).join(' | '));
  check('the target window came back', targets?.lowKph === 20 && targets?.highKph === 35, JSON.stringify(targets));
});

spinStatus.notify(bytes2(0x14, 0x01));
spinStatus.notify(bytes2(0x14, 0x04));
spinStatus.notify(bytes2(0x14, 0x02));
spinStatus.notify(bytes2(0x14, 0x03));
spinStatus.notify(bytes2(0xff));
spinStatus.notify(bytes2(0x14)); // truncated, ignored

suite('spin-down status reaches the listener', () => {
  check('each status maps to its signal, and a truncated one is ignored',
    signals.join(' ') === 'speedUp stopPedalling success error controlLost', signals.join(' '));
  check('the panel text follows the spin-down',
    spinTrainer.lastMachineStatus === 'spin-down status', spinTrainer.lastMachineStatus ?? 'none');
});

spinStatus.notify(bytes2(0x14, 0x02));
suite('the panel shows the spin-down result', () => {
  check('a success reads as such',
    spinTrainer.lastMachineStatus === 'spin-down succeeded', spinTrainer.lastMachineStatus ?? 'none');
});

const beforeCancel = spinControl.writes.length;
await spinTrainer.control!.spinDown!.cancel();

suite('cancelling sends ignore', () => {
  // Control was taken back by the 0xFF above, so it is requested again first.
  const sent = spinControl.writes.map(hex).slice(beforeCancel);
  check('0x13 0x02 went out, after re-requesting control', sent.join(' | ') === '00 | 07 | 13 02',
    sent.join(' | '));
});

signals.length = 0;
spinBt.drop();
await wait(1400);
spinStatus.notify(bytes2(0x14, 0x04));

suite('a reconnect does not double spin-down signals', () => {
  check('it reconnected', spinTrainer.status === 'connected', spinTrainer.status);
  check('one status gives one signal', signals.join(' ') === 'stopPedalling', signals.join(' '));
});
await spinTrainer.disconnect();

const refusingSpinBt = buildSpinTrainer('refusing-spin', () => bytes2(0x80, 0x13, 0x02));
const refusingSpin = new FtmsTrainer(refusingSpinBt as unknown as BluetoothDevice);
await refusingSpin.connect();
await wait(60);
let spinError = '';
try {
  await refusingSpin.control!.spinDown!.start();
} catch (err) {
  spinError = (err as Error).message;
}
await refusingSpin.disconnect();

suite('a refused spin-down says why', () => {
  check('start rejected', spinError !== '', 'resolved');
  check('with the trainer’s reason', /opcode not supported/.test(spinError), spinError);
});

const readOnlyBt = new FakeBluetoothDevice('readonly-trainer', 'Dumb Trainer');
readOnlyBt.service(SERVICE.fitnessMachine).add(CHARACTERISTIC.indoorBikeData);
readOnlyBt.service(SERVICE.fitnessMachine)
  .add(CHARACTERISTIC.fitnessMachineFeature, bytes(...u32le(1 << 14), ...u32le(0)));
const readOnly = new FtmsTrainer(readOnlyBt as unknown as BluetoothDevice);
await readOnly.connect();

suite('a trainer with no control point is read-only', () => {
  check('it connected', readOnly.status === 'connected', readOnly.status);
  check('but offers no control, so the session will not try', readOnly.control === undefined);
  check('and says so', readOnly.describeControl() === 'no control point — read only',
    readOnly.describeControl());
  check('its control state reads as read only', readOnly.describeControlState() === 'read only',
    readOnly.describeControlState());
});

// --- the rider disconnects deliberately ------------------------------------
await trainer.disconnect();
const connectsAtDisconnect = bt.gatt.connectCalls;
bt.emitDisconnected();
await wait(1200);

suite('a deliberate disconnect stays disconnected', () => {
  check('status is disconnected', trainer.status === 'disconnected', trainer.status);
  check('notifications were stopped',
    (bt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.indoorBikeData)?.stopCalls ?? 0) >= 1);
  check('no reconnect was attempted', bt.gatt.connectCalls === connectsAtDisconnect,
    `${connectsAtDisconnect} → ${bt.gatt.connectCalls}`);
});

// --- a device that connects but cannot work ---------------------------------
const bare = new FakeBluetoothDevice('bare-trainer', 'Mystery Trainer');
bare.service(SERVICE.fitnessMachine).add(CHARACTERISTIC.fitnessMachineFeature, bytes(...u32le(0), ...u32le(0)));
const bareTrainer = new FtmsTrainer(bare as unknown as BluetoothDevice);
let bareError = '';
try {
  await bareTrainer.connect();
} catch (err) {
  bareError = (err as Error).message;
}
const bareStatusAfterFailure = bareTrainer.status;
const bareConnectsAfterFailure = bare.gatt.connectCalls;
bare.emitDisconnected();
await wait(1200);

suite('a trainer with no Indoor Bike Data is rejected clearly', () => {
  check('connect rejected', bareError !== '', 'connect resolved instead of throwing');
  check('the error names the missing characteristic', /Indoor Bike Data/.test(bareError), bareError);
  check('status is error', bareStatusAfterFailure === 'error', bareStatusAfterFailure);
  check('the reason is kept for the panel to show',
    /Indoor Bike Data/.test(bareTrainer.lastError ?? ''), bareTrainer.lastError ?? 'none');
  check('a read-only trainer says so',
    bareTrainer.describeControl() === 'no control point — read only', bareTrainer.describeControl());
  check('the useless link was closed rather than left half-open', !bare.gatt.connected);
  check('and it is not retried, since it can never work',
    bare.gatt.connectCalls === bareConnectsAfterFailure,
    `${bareConnectsAfterFailure} → ${bare.gatt.connectCalls}`);
});

// --- heart rate -------------------------------------------------------------
const strapBt = new FakeBluetoothDevice('strap-xyz', 'Polar H10');
strapBt.service(SERVICE.heartRate).add(CHARACTERISTIC.heartRateMeasurement);
strapBt.service(SERVICE.heartRate).add(CHARACTERISTIC.bodySensorLocation, bytes(1));
const strap = new BleHeartRateMonitor(strapBt as unknown as BluetoothDevice);
const strapSeen = collect(strap);
await strap.connect();
const hrChar = strapBt.characteristic(SERVICE.heartRate, CHARACTERISTIC.heartRateMeasurement)!;
hrChar.notify(bytes(0x06, 142));
hrChar.notify(bytes(0x04, 139));
hrChar.notify(bytes(0x06, 145));

suite('heart rate strap', () => {
  check('body sensor location was read', strap.location === 'chest', strap.location ?? 'none');
  check('readings with skin contact are kept', strapSeen.length === 2, String(strapSeen.length));
  check('the reading taken with no skin contact was dropped',
    strapSeen.map((t) => t.heartRate).join(',') === '142,145',
    strapSeen.map((t) => t.heartRate).join(','));
  check('contact loss is remembered for the UI', strap.contactDetected === true);
});

// --- power meter ------------------------------------------------------------
const meterBt = new FakeBluetoothDevice('meter-123', 'Favero Assioma');
meterBt.service(SERVICE.cyclingPower).add(CHARACTERISTIC.cyclingPowerMeasurement);
const meter = new BlePowerMeter(meterBt as unknown as BluetoothDevice);
const meterSeen = collect(meter);
await meter.connect();
const cpm = meterBt.characteristic(SERVICE.cyclingPower, CHARACTERISTIC.cyclingPowerMeasurement)!;
cpm.notify(bytes(...u16le(0x0020), ...u16le(210), ...u16le(100), ...u16le(1000)));
cpm.notify(bytes(...u16le(0x0020), ...u16le(215), ...u16le(101), ...u16le(2024)));

suite('power meter with crank cadence', () => {
  check('two updates arrived', meterSeen.length === 2, String(meterSeen.length));
  near('power from the first packet', meterSeen[0].power!, 210, 0.001);
  check('the first packet cannot give a cadence yet', meterSeen[0].cadence === undefined);
  near('cadence from the second packet', meterSeen[1].cadence!, 60, 0.01);
  check('the meter noticed it reports crank revolutions', meter.reportsCadence);
  check('and that it has no wheel sensor', !meter.reportsWheel);
});

report();
