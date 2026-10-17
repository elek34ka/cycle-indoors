import {
  CONTROL_OPCODE, FtmsControlPoint, RESULT, encodeRequestControl, encodeSimulation,
  encodeStartOrResume, encodeStopOrPause, encodeTargetPower, opcodeName, parseControlResponse,
  type ControlPointIO,
} from '../src/devices/ble/ftms-control';
import { check, near, report, suite } from './harness';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
const dv = (...bytes: number[]) => new DataView(Uint8Array.from(bytes).buffer);
const response = (opcode: number, result: number) => dv(0x80, opcode, result);

const SIM = { grade: 0, crr: 0.004, cw: 0.51, windSpeed: 0 };

suite('control point encoders', () => {
  check('request control', hex(encodeRequestControl()) === '00', hex(encodeRequestControl()));
  check('start or resume', hex(encodeStartOrResume()) === '07', hex(encodeStartOrResume()));
  check('stop', hex(encodeStopOrPause(false)) === '08 01', hex(encodeStopOrPause(false)));
  check('pause', hex(encodeStopOrPause(true)) === '08 02', hex(encodeStopOrPause(true)));

  check('250 W target is a little-endian sint16',
    hex(encodeTargetPower(250)) === '05 fa 00', hex(encodeTargetPower(250)));
  check('a target is rounded', hex(encodeTargetPower(249.6)) === '05 fa 00', hex(encodeTargetPower(249.6)));
  check('zero watts releases the brake', hex(encodeTargetPower(0)) === '05 00 00', hex(encodeTargetPower(0)));
  check('the target field is signed', hex(encodeTargetPower(-50)) === '05 ce ff', hex(encodeTargetPower(-50)));
  check('1000 W encodes correctly', hex(encodeTargetPower(1000)) === '05 e8 03', hex(encodeTargetPower(1000)));

  // grade 4.5% -> 450 (0x01c2), crr 0.004 -> 40 (0x28), cw 0.51 -> 51 (0x33)
  const climb = encodeSimulation({ ...SIM, grade: 4.5 });
  check('a 4.5% climb', hex(climb) === '11 00 00 c2 01 28 33', hex(climb));
  const descent = encodeSimulation({ ...SIM, grade: -3.2 });
  check('a descent uses a signed grade', hex(descent) === '11 00 00 c0 fe 28 33', hex(descent));
  const windy = encodeSimulation({ ...SIM, windSpeed: 18 });
  check('18 km/h of head wind is 5 m/s at 0.001 per bit',
    hex(windy) === '11 88 13 00 00 28 33', hex(windy));
  check('the simulation packet is seven bytes', encodeSimulation(SIM).byteLength === 7);

  const clamped = encodeSimulation({ grade: 500, crr: 0.05, cw: 9, windSpeed: 0 });
  check('an absurd grade is clamped to the field width',
    hex(clamped).startsWith('11 00 00 ff 7f'), hex(clamped));
  check('rolling resistance and wind coefficients are clamped to a byte',
    hex(clamped).endsWith('ff ff'), hex(clamped));

  check('opcodes have names', opcodeName(CONTROL_OPCODE.setTargetPower) === 'set target power');
  check('unknown opcodes still read sensibly', opcodeName(0x42) === 'opcode 0x42', opcodeName(0x42));
});

suite('control point responses', () => {
  const ok = parseControlResponse(response(CONTROL_OPCODE.setTargetPower, RESULT.success))!;
  check('a success is recognised', ok.ok && ok.requestOpcode === CONTROL_OPCODE.setTargetPower);
  check('and described', ok.text === 'success', ok.text);

  const denied = parseControlResponse(response(CONTROL_OPCODE.requestControl, RESULT.notPermitted))!;
  check('control not permitted is recognised', !denied.ok && denied.text === 'control not permitted', denied.text);
  check('unsupported opcodes are recognised',
    parseControlResponse(response(0x05, RESULT.notSupported))!.text === 'opcode not supported');

  check('a short packet is not a response', parseControlResponse(dv(0x80, 0x05)) === undefined);
  check('a packet that is not 0x80 is not a response',
    parseControlResponse(dv(0x05, 0x00, 0x01)) === undefined);
});

/** A control point that records writes and can answer them like a trainer. */
class FakeIo implements ControlPointIO {
  writes: string[] = [];
  inflight = 0;
  maxInflight = 0;
  delayMs = 0;
  fail = false;
  reply: (bytes: Uint8Array) => DataView | undefined = () => undefined;
  point: FtmsControlPoint | undefined;

  async write(bytes: Uint8Array): Promise<void> {
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    if (this.delayMs) await wait(this.delayMs);
    this.inflight--;
    if (this.fail) throw new Error('GATT write failed');
    this.writes.push(hex(bytes));
    const answer = this.reply(bytes);
    if (answer) queueMicrotask(() => this.point?.onIndication(answer));
  }
}

function alwaysSucceed(bytes: Uint8Array): DataView {
  return response(bytes[0], RESULT.success);
}

// --- a well-behaved trainer -------------------------------------------------
const good = new FakeIo();
good.reply = alwaysSucceed;
const goodPoint = new FtmsControlPoint(good, 200);
good.point = goodPoint;

await goodPoint.command(encodeTargetPower(250), CONTROL_OPCODE.setTargetPower);

suite('a target asks for control first', () => {
  check('three writes: request control, start, then the target',
    good.writes.join(' | ') === '00 | 07 | 05 fa 00', good.writes.join(' | '));
  check('control is held', goodPoint.hasControl);
  check('the trainer answered, so it is not marked silent', !goodPoint.silent);
  check('the last result is remembered for the panel',
    goodPoint.lastResult === 'set target power: success', goodPoint.lastResult ?? 'none');
});

await goodPoint.command(encodeTargetPower(300), CONTROL_OPCODE.setTargetPower);

suite('control is only requested once', () => {
  check('the second target goes straight out',
    good.writes.join(' | ') === '00 | 07 | 05 fa 00 | 05 2c 01', good.writes.join(' | '));
});

// --- GATT allows one operation at a time -----------------------------------
const serial = new FakeIo();
serial.reply = alwaysSucceed;
serial.delayMs = 10;
const serialPoint = new FtmsControlPoint(serial, 200);
serial.point = serialPoint;

await Promise.all([
  serialPoint.command(encodeTargetPower(100), CONTROL_OPCODE.setTargetPower),
  serialPoint.command(encodeTargetPower(200), CONTROL_OPCODE.setTargetPower),
  serialPoint.command(encodeTargetPower(300), CONTROL_OPCODE.setTargetPower),
]);

suite('concurrent commands are serialised and ordered', () => {
  check('never two GATT writes at once', serial.maxInflight === 1, String(serial.maxInflight));
  check('control was requested exactly once, not once per command',
    serial.writes.filter((w) => w === '00').length === 1, serial.writes.join(' | '));
  check('all three targets were sent', serial.writes.filter((w) => w.startsWith('05')).length === 3,
    serial.writes.join(' | '));
  // Out-of-order targets would leave the trainer holding a wattage the workout
  // has already moved past.
  check('in the order they were asked for',
    serial.writes.filter((w) => w.startsWith('05')).join(' | ') === '05 64 00 | 05 c8 00 | 05 2c 01',
    serial.writes.join(' | '));
  check('the whole exchange is in order',
    serial.writes.join(' | ') === '00 | 07 | 05 64 00 | 05 c8 00 | 05 2c 01', serial.writes.join(' | '));
});

// --- a trainer that never answers ------------------------------------------
const silent = new FakeIo();
const silentPoint = new FtmsControlPoint(silent, 60);
silent.point = silentPoint;
await silentPoint.command(encodeTargetPower(200), CONTROL_OPCODE.setTargetPower);

suite('a trainer that never acknowledges is still ridable', () => {
  check('the target was still sent', silent.writes.includes('05 c8 00'), silent.writes.join(' | '));
  check('it is flagged as silent so the panel can say so', silentPoint.silent);
  check('control is assumed rather than blocking the ride', silentPoint.hasControl);
});

// --- a trainer that refuses control ----------------------------------------
const refusing = new FakeIo();
refusing.reply = (bytes) => response(bytes[0], RESULT.notPermitted);
const refusingPoint = new FtmsControlPoint(refusing, 200);
refusing.point = refusingPoint;
let refusalError = '';
try {
  await refusingPoint.command(encodeTargetPower(200), CONTROL_OPCODE.setTargetPower);
} catch (err) {
  refusalError = (err as Error).message;
}

suite('a refusal is reported, not swallowed', () => {
  check('the command rejected', refusalError !== '', 'command resolved');
  check('with the trainer’s own reason', /refused control/.test(refusalError), refusalError);
  check('no target was sent', !refusing.writes.some((w) => w.startsWith('05')), refusing.writes.join(' | '));
  check('control is not claimed', !refusingPoint.hasControl);
});

// --- control taken away mid-ride -------------------------------------------
const revoking = new FakeIo();
revoking.reply = alwaysSucceed;
const revokingPoint = new FtmsControlPoint(revoking, 200);
revoking.point = revokingPoint;
await revokingPoint.command(encodeTargetPower(200), CONTROL_OPCODE.setTargetPower);
const writesBefore = revoking.writes.length;
revokingPoint.invalidate(); // as the trainer's 0xFF machine status does
await revokingPoint.command(encodeTargetPower(210), CONTROL_OPCODE.setTargetPower);

suite('losing control re-requests it rather than failing', () => {
  const after = revoking.writes.slice(writesBefore);
  check('control was requested again', after[0] === '00', after.join(' | '));
  check('and the target followed', after.includes('05 d2 00'), after.join(' | '));
  check('control is held again', revokingPoint.hasControl);
});

// --- a target the trainer rejects ------------------------------------------
const picky = new FakeIo();
picky.reply = (bytes) => response(
  bytes[0],
  bytes[0] === CONTROL_OPCODE.setTargetPower ? RESULT.invalidParameter : RESULT.success,
);
const pickyPoint = new FtmsControlPoint(picky, 200);
picky.point = pickyPoint;
let targetError = '';
try {
  await pickyPoint.command(encodeTargetPower(9000), CONTROL_OPCODE.setTargetPower);
} catch (err) {
  targetError = (err as Error).message;
}

suite('a rejected target says which command failed and why', () => {
  check('it rejected', targetError !== '', 'resolved');
  check('naming the command', /set target power/.test(targetError), targetError);
  check('and the reason', /invalid parameter/.test(targetError), targetError);
  check('control is still held, since that is not what was refused', pickyPoint.hasControl);
});

// --- the write itself fails -------------------------------------------------
const broken = new FakeIo();
broken.reply = alwaysSucceed;
const brokenPoint = new FtmsControlPoint(broken, 60);
broken.point = brokenPoint;
await brokenPoint.ensureControl();
broken.fail = true;
let writeError = '';
try {
  await brokenPoint.command(encodeTargetPower(200), CONTROL_OPCODE.setTargetPower);
} catch (err) {
  writeError = (err as Error).message;
}
broken.fail = false;
await brokenPoint.command(encodeTargetPower(205), CONTROL_OPCODE.setTargetPower);

suite('a failed GATT write surfaces and does not jam the queue', () => {
  check('the command rejected', /write failed/.test(writeError), writeError);
  check('a later command still gets through', broken.writes.includes('05 cd 00'),
    broken.writes.join(' | '));
});

report();
