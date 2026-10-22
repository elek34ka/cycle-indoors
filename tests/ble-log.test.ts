import { BleLog } from '../src/devices/ble/log';
import { CHARACTERISTIC } from '../src/devices/ble/uuids';
import { check, report, suite } from './harness';

const empty = new BleLog();

suite('an empty log says so', () => {
  check('no entries', empty.entries().length === 0);
  check('the text explains it is empty', /empty/.test(empty.toText()), empty.toText());
});

const log = new BleLog(3);
log.record({ device: 'Trainer', kind: 'write', uuid: CHARACTERISTIC.fitnessMachineControlPoint,
  bytes: Uint8Array.of(0x05, 0x78, 0x00) });
log.record({ device: 'Trainer', kind: 'response', uuid: CHARACTERISTIC.fitnessMachineControlPoint,
  bytes: new DataView(Uint8Array.of(0x80, 0x05, 0x01).buffer), note: 'set target power: success' });

suite('entries keep their order and their bytes', () => {
  const [write, response] = log.entries();
  check('two entries', log.entries().length === 2, String(log.entries().length));
  check('the write first, as hex', write.kind === 'write' && write.hex === '05 78 00', JSON.stringify(write));
  check('then the response, from a DataView', response.kind === 'response' && response.hex === '80 05 01',
    JSON.stringify(response));
});

suite('the text has one line per entry, oldest first', () => {
  const lines = log.toText().trimEnd().split('\n');
  check('two lines', lines.length === 2, lines.join(' / '));
  check('the characteristic is named', lines[0].includes('fitnessMachineControlPoint'), lines[0]);
  check('the bytes are there', lines[0].includes('05 78 00') && lines[1].includes('80 05 01'), lines.join(' / '));
  check('so is the note', lines[1].endsWith('set target power: success'), lines[1]);
  check('it starts with an ISO time', /^\d{4}-\d\d-\d\dT/.test(lines[0]), lines[0]);
});

log.record({ device: 'Trainer', kind: 'notify', uuid: CHARACTERISTIC.indoorBikeData, bytes: Uint8Array.of(1) });
log.record({ device: 'Trainer', kind: 'notify', uuid: CHARACTERISTIC.indoorBikeData, bytes: Uint8Array.of(2) });

suite('past the limit the oldest are dropped', () => {
  const hexes = log.entries().map((e) => e.hex);
  check('only the limit is kept', hexes.length === 3, String(hexes.length));
  check('the newest survive', hexes.join(' | ') === '80 05 01 | 01 | 02', hexes.join(' | '));
});

log.clear();
check('clearing empties it', log.entries().length === 0);

const switched = new BleLog();
switched.record({ device: 'Trainer', kind: 'notify', bytes: Uint8Array.of(1) });
switched.enabled = false;
const afterOff = switched.entries().length;
switched.record({ device: 'Trainer', kind: 'notify', bytes: Uint8Array.of(2) });
const whileOff = switched.entries().length;
switched.enabled = true;
switched.record({ device: 'Trainer', kind: 'notify', bytes: Uint8Array.of(3) });

suite('a switched-off log records nothing and gives its memory back', () => {
  check('switching off empties it', afterOff === 0, String(afterOff));
  check('nothing is recorded while off', whileOff === 0, String(whileOff));
  check('switched on again, it records', switched.entries().map((e) => e.hex).join() === '03',
    switched.entries().map((e) => e.hex).join());
});

report();
