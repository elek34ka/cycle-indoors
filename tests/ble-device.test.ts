import { setupDom } from './dom-setup';
setupDom();

import { FakeBluetoothDevice, bytes, text, u16le, u32le } from './fake-gatt';

const { FtmsTrainer } = await import('../src/devices/ble/ftms');
const { CHARACTERISTIC, SERVICE } = await import('../src/devices/ble/uuids');
const { settings } = await import('../src/core/settings');
// The Bluetooth log only records in debug mode.
const debugDefault = settings.current.debugMode;
settings.patch({ debugMode: true });
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

settings.patch({ debugMode: debugDefault });
report();
