import {
  parseCsc, parseCyclingPower, parseFitnessMachineFeature, parseHeartRate,
  parseIndoorBikeData, parseSupportedPowerRange, parseUtf8,
} from '../src/devices/ble/parsers';
import { CrankCadenceTracker, WheelSpeedTracker } from '../src/devices/ble/revolutions';
import { uuid16 } from '../src/devices/ble/pair';
import { DeviceHub } from '../src/devices/hub';
import { Emitter } from '../src/core/pubsub';
import type { Device, DeviceRole, DeviceStatus, Telemetry } from '../src/devices/types';
import { check, near, report, suite } from './harness';

const dv = (...bytes: number[]) => new DataView(Uint8Array.from(bytes).buffer);
const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const u32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const u24 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];

suite('Indoor Bike Data (FTMS 0x2AD2)', () => {
  // bit 0 is "More Data" and is inverted: speed is present when it is CLEAR.
  const typical = parseIndoorBikeData(dv(...u16(0x0044), ...u16(3000), ...u16(180), ...u16(250)));
  near('speed is 0.01 km/h per bit', typical.speed!, 30, 0.001);
  near('cadence is 0.5 rpm per bit', typical.cadence!, 90, 0.001);
  near('power is watts', typical.power!, 250, 0.001);

  const noSpeed = parseIndoorBikeData(dv(...u16(0x0041), ...u16(300)));
  check('More Data set means no instantaneous speed', noSpeed.speed === undefined);
  near('the power field still lands correctly', noSpeed.power!, 300, 0.001);

  const rich = parseIndoorBikeData(dv(
    ...u16(0x0250), ...u16(2500), ...u24(12345), ...u16(180), 140,
  ));
  near('speed', rich.speed!, 25, 0.001);
  near('total distance is a 24-bit field in metres', rich.totalDistance!, 12345, 0.001);
  near('power after a 24-bit distance', rich.power!, 180, 0.001);
  near('heart rate passed through the trainer', rich.heartRate!, 140, 0.001);

  const everything = parseIndoorBikeData(dv(
    ...u16(0b0001111111111111), // bit 0 set = no instantaneous speed, every other field present
    ...u16(2000), // avg speed
    ...u16(170),  // cadence
    ...u16(160),  // avg cadence
    ...u24(5000), // distance
    ...u16(12),   // resistance
    ...u16(240),  // power
    ...u16(230),  // avg power
    ...u16(45), ...u16(600), 10, // energy: total, per hour, per minute
    135,          // heart rate
    85,           // metabolic equivalent
    ...u16(1800), // elapsed
    ...u16(600),  // remaining
  ));
  check('no instantaneous speed when More Data is set', everything.speed === undefined);
  near('average speed', everything.avgSpeed!, 20, 0.001);
  near('instantaneous cadence', everything.cadence!, 85, 0.001);
  near('average cadence', everything.avgCadence!, 80, 0.001);
  near('total distance', everything.totalDistance!, 5000, 0.001);
  near('resistance', everything.resistance!, 12, 0.001);
  near('average power', everything.avgPower!, 230, 0.001);
  near('total energy', everything.totalEnergy!, 45, 0.001);
  near('energy per hour', everything.energyPerHour!, 600, 0.001);
  near('energy per minute', everything.energyPerMinute!, 10, 0.001);
  near('metabolic equivalent is 0.1 per bit', everything.metabolicEquivalent!, 8.5, 0.001);
  near('elapsed time', everything.elapsedTime!, 1800, 0.001);
  near('remaining time', everything.remainingTime!, 600, 0.001);
  check('every field landed on its own value',
    everything.power === 240 && everything.heartRate === 135,
    `power ${everything.power}, hr ${everything.heartRate}`);

  const negative = parseIndoorBikeData(dv(...u16(0x0041), ...u16(0xfffb)));
  near('power is signed', negative.power!, -5, 0.001);

  const unavailable = parseIndoorBikeData(dv(...u16(0x0041), ...u16(0x7fff)));
  check('the "not available" power sentinel is dropped', unavailable.power === undefined);

  const truncated = parseIndoorBikeData(dv(...u16(0x0044), ...u16(3000)));
  check('a short packet yields what it can without throwing',
    truncated.speed === 30 && truncated.cadence === undefined && truncated.power === undefined,
    JSON.stringify(truncated));
});

suite('Heart Rate Measurement (0x2A37)', () => {
  const small = parseHeartRate(dv(0x00, 72));
  check('8-bit heart rate', small.heartRate === 72, String(small.heartRate));
  check('contact status is absent when unsupported', small.contactDetected === undefined);

  const wide = parseHeartRate(dv(0x01, ...u16(185)));
  check('16-bit heart rate when bit 0 is set', wide.heartRate === 185, String(wide.heartRate));

  check('contact supported and made', parseHeartRate(dv(0x06, 120)).contactDetected === true);
  check('contact supported and lost', parseHeartRate(dv(0x04, 120)).contactDetected === false);

  const full = parseHeartRate(dv(0b00011000, 150, ...u16(320), ...u16(1024), ...u16(512)));
  check('heart rate before the optional fields', full.heartRate === 150, String(full.heartRate));
  check('energy expended', full.energyExpended === 320, String(full.energyExpended));
  near('first RR interval is 1/1024 s per bit', full.rrIntervals![0], 1, 0.001);
  near('second RR interval', full.rrIntervals![1], 0.5, 0.001);
  check('both RR intervals were read', full.rrIntervals!.length === 2);
});

suite('Cycling Power Measurement (0x2A63)', () => {
  const plain = parseCyclingPower(dv(...u16(0x0000), ...u16(200)));
  check('instantaneous power always follows the flags', plain.power === 200, String(plain.power));

  const crankOnly = parseCyclingPower(dv(...u16(0x0020), ...u16(180), ...u16(500), ...u16(1024)));
  check('crank revolutions', crankOnly.crank?.revolutions === 500, String(crankOnly.crank?.revolutions));
  check('crank event time', crankOnly.crank?.time === 1024, String(crankOnly.crank?.time));
  check('no wheel data when its bit is clear', crankOnly.wheel === undefined);

  const both = parseCyclingPower(dv(
    ...u16(0x0030), ...u16(210), ...u32(9000), ...u16(2048), ...u16(700), ...u16(512),
  ));
  check('wheel comes before crank', both.wheel?.revolutions === 9000 && both.crank?.revolutions === 700,
    `${both.wheel?.revolutions} / ${both.crank?.revolutions}`);

  // Every optional field set: this is the real test of the skip offsets, since
  // accumulated energy sits behind five variable-length blocks.
  const kitchenSink = parseCyclingPower(dv(
    ...u16(0x0ff5), ...u16(200),
    100,                        // pedal power balance, 0.5% per bit
    ...u16(320),                // accumulated torque, 1/32 Nm
    ...u32(1000), ...u16(2048), // wheel
    ...u16(500), ...u16(1024),  // crank
    0, 0, 0, 0,                 // extreme force magnitudes
    0, 0, 0, 0,                 // extreme torque magnitudes
    0, 0, 0,                    // extreme angles
    0, 0,                       // top dead spot
    0, 0,                       // bottom dead spot
    ...u16(42),                 // accumulated energy
  ));
  check('power', kitchenSink.power === 200, String(kitchenSink.power));
  near('pedal balance is 0.5% per bit', kitchenSink.balance!, 50, 0.001);
  near('accumulated torque is 1/32 Nm per bit', kitchenSink.accumulatedTorque!, 10, 0.001);
  check('wheel survives the optional fields before it', kitchenSink.wheel?.revolutions === 1000);
  check('crank survives too', kitchenSink.crank?.revolutions === 500);
  check('accumulated energy is found behind every skipped block',
    kitchenSink.accumulatedEnergy === 42, String(kitchenSink.accumulatedEnergy));
});

suite('cadence from crank revolutions', () => {
  const tracker = new CrankCadenceTracker();
  check('the first event cannot give a cadence', tracker.update({ revolutions: 10, time: 1000 }, 0) === undefined);
  near('one revolution per second is 60 rpm', tracker.update({ revolutions: 11, time: 2024 }, 1000)!, 60, 0.01);
  near('one revolution per half second is 120 rpm', tracker.update({ revolutions: 12, time: 2536 }, 1500)!, 120, 0.01);

  const wrapping = new CrankCadenceTracker();
  wrapping.update({ revolutions: 65535, time: 65000 }, 0);
  near('event time rollover is handled', wrapping.update({ revolutions: 0, time: 488 }, 1000)!, 60, 0.01);
  near('revolution counter rollover is handled too',
    wrapping.update({ revolutions: 1, time: 1512 }, 2000)!, 60, 0.01);

  const coasting = new CrankCadenceTracker();
  coasting.update({ revolutions: 100, time: 1000 }, 0);
  coasting.update({ revolutions: 101, time: 2024 }, 1000);
  near('a repeated event holds the last cadence briefly',
    coasting.update({ revolutions: 101, time: 2024 }, 2000)!, 60, 0.01);
  check('after a few seconds with no new event, cadence is zero',
    coasting.update({ revolutions: 101, time: 2024 }, 5000) === 0);
});

// ---- hub source selection -------------------------------------------------

function fakeDevice(id: string, roles: DeviceRole[], label = id) {
  const bus = new Emitter<{ data: Telemetry; status: DeviceStatus }>();
  const device: Device = {
    id, label, roles, transport: 'mock', status: 'connected',
    connect: async () => {}, disconnect: async () => {},
    onTelemetry: (h) => bus.on('data', h),
    onStatus: (h) => bus.on('status', h),
  };
  return { device, push: (t: Telemetry) => bus.emit('data', t) };
}

suite('the hub prefers a dedicated sensor over the trainer', () => {
  const localHub = new DeviceHub();
  const trainer = fakeDevice('trainer-1', ['trainer', 'power', 'cadence', 'speed'], 'Trainer');
  const strap = fakeDevice('strap-1', ['heartRate'], 'Strap');
  const meter = fakeDevice('meter-1', ['power', 'cadence'], 'Power meter');
  localHub.register(trainer.device);
  localHub.register(strap.device);
  localHub.register(meter.device);

  trainer.push({ power: 200, cadence: 85, speed: 32, heartRate: 110 });
  check('with only the trainer, its values are used', localHub.snapshot().power === 200);
  check('the trainer supplies heart rate when nothing else does', localHub.snapshot().heartRate === 110);

  strap.push({ heartRate: 152 });
  check('a real strap wins for heart rate', localHub.snapshot().heartRate === 152,
    String(localHub.snapshot().heartRate));
  check('the strap is named as the heart-rate source',
    localHub.sourceOf('heartRate')?.label === 'Strap', localHub.sourceOf('heartRate')?.label);

  meter.push({ power: 207, cadence: 88 });
  check('a power meter wins for power', localHub.snapshot().power === 207, String(localHub.snapshot().power));
  check('and for cadence', localHub.snapshot().cadence === 88);
  check('the trainer still supplies speed', localHub.snapshot().speed === 32);
  check('power is attributed to the meter', localHub.sourceOf('power')?.label === 'Power meter');

  const future = performance.now() + 6000;
  check('readings go stale rather than freezing on screen',
    localHub.snapshot(future).power === undefined, JSON.stringify(localHub.snapshot(future)));
  check('a stale metric has no source', localHub.sourceOf('power', future) === undefined);
});

report();
