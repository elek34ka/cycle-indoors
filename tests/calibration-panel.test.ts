import { setupDom } from './dom-setup';
const dom = setupDom();

import { FakeBluetoothDevice, bytes, u16le, u32le } from './fake-gatt';

const { check, report, suite } = await import('./harness');
const { bootApp } = await import('../src/ui/app');
const { hub } = await import('../src/devices/hub');
const { mock } = await import('../src/devices/setup');
const { session } = await import('../src/session/session');
const { settings } = await import('../src/core/settings');
const { FtmsTrainer } = await import('../src/devices/ble/ftms');
const { CHARACTERISTIC, SERVICE } = await import('../src/devices/ble/uuids');

const doc = dom.window.document;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** An FTMS trainer whose control point acknowledges everything, and answers a
 *  spin-down start with a 20–35 km/h window. */
function fakeTrainer(id: string, spinDown: boolean): FakeBluetoothDevice {
  const bt = new FakeBluetoothDevice(id, spinDown ? 'Spin Trainer' : 'Plain Trainer');
  const ftms = bt.service(SERVICE.fitnessMachine);
  ftms.add(CHARACTERISTIC.indoorBikeData);
  ftms.add(CHARACTERISTIC.fitnessMachineStatus);
  ftms.add(CHARACTERISTIC.fitnessMachineControlPoint).onWrite = (written) => bytes(
    0x80, written[0], 0x01,
    ...(written[0] === 0x13 && written[1] === 0x01 ? [...u16le(2000), ...u16le(3500)] : []),
  );
  ftms.add(CHARACTERISTIC.fitnessMachineFeature, bytes(
    ...u32le((1 << 1) | (1 << 14)),
    ...u32le((1 << 3) | (1 << 13) | (spinDown ? 1 << 15 : 0)),
  ));
  return bt;
}

async function connectTrainer(bt: FakeBluetoothDevice) {
  const trainer = new FtmsTrainer(bt as unknown as BluetoothDevice);
  hub.register(trainer);
  await trainer.connect();
  await wait(60);
  return trainer;
}

const calibrationOf = (label: string) => {
  const row = [...doc.querySelectorAll<HTMLElement>('#devices-panel .device-row')]
    .find((r) => r.querySelector('.name')?.textContent === label);
  const area = row?.querySelector<HTMLElement>('.calibration');
  const button = area?.querySelector<HTMLButtonElement>('button');
  return {
    shown: area !== null && area !== undefined && !area.hidden,
    button: button?.textContent ?? '',
    disabled: button?.disabled ?? true,
    text: area?.querySelector('.calibration-text')?.textContent ?? '',
    click: () => button?.click(),
  };
};

const simulatorDefault = settings.current.useMockDevices;
settings.patch({ useMockDevices: true });
bootApp();
for (let i = 0; i < 50 && mock.trainer.status !== 'connected'; i++) await wait(100);

suite('the simulated trainer offers no calibration', () => {
  check('the simulator is connected', mock.trainer.status === 'connected', mock.trainer.status);
  check('no Calibrate on its row', !calibrationOf(mock.trainer.label).shown);
});

await hub.unregister('mock-trainer');
await hub.unregister('mock-hrm');

const plain = await connectTrainer(fakeTrainer('plain-trainer', false));

suite('a trainer without spin-down support offers no calibration', () => {
  check('it is the trainer in charge', hub.trainer === plain);
  check('no Calibrate on its row', !calibrationOf('Plain Trainer').shown);
});

await hub.unregister(plain.id);
const spinBt = fakeTrainer('spin-trainer', true);
const spin = await connectTrainer(spinBt);
const status = spinBt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineStatus)!;

suite('a trainer that supports spin-down offers it when idle', () => {
  check('it is the trainer in charge', hub.trainer === spin);
  const c = calibrationOf('Spin Trainer');
  check('Calibrate is shown', c.shown && c.button === 'Calibrate', JSON.stringify(c));
  check('and enabled', !c.disabled);
});

session.start();

suite('it is disabled while a ride is running', () => {
  const c = calibrationOf('Spin Trainer');
  check('disabled', c.shown && c.disabled, JSON.stringify(c));
  check('saying why', /Finish the ride first/.test(c.text), c.text);
});

session.finish();

suite('it is offered again once the ride is finished', () => {
  const c = calibrationOf('Spin Trainer');
  check('enabled', c.shown && !c.disabled && c.text === '', JSON.stringify(c));
});

calibrationOf('Spin Trainer').click();
await wait(30);

suite('pressing Calibrate guides the rider', () => {
  const c = calibrationOf('Spin Trainer');
  check('it asks to speed up past the high target', /Speed up past 35 km\/h/.test(c.text), c.text);
  check('with the window', /20–35 km\/h/.test(c.text), c.text);
  check('and offers Cancel', c.button === 'Cancel', c.button);
});

status.notify(bytes(0x14, 0x04));
suite('stop pedalling is shown at once', () => {
  check('coast', /Stop pedalling/.test(calibrationOf('Spin Trainer').text), calibrationOf('Spin Trainer').text);
});

status.notify(bytes(0x14, 0x02));

suite('the result stays until dismissed', () => {
  const c = calibrationOf('Spin Trainer');
  check('success is shown', c.text === 'Calibration succeeded', c.text);
  check('with Dismiss', c.button === 'Dismiss', c.button);
  calibrationOf('Spin Trainer').click();
  const after = calibrationOf('Spin Trainer');
  check('dismissing clears it', after.button === 'Calibrate' && after.text === '', JSON.stringify(after));
});

await spin.disconnect();

suite('a disconnected trainer offers no calibration', () => {
  check('hidden', !calibrationOf('Spin Trainer').shown);
});

// --- the Bluetooth log download -------------------------------------------------
const { bleLog } = await import('../src/devices/ble/log');
let downloaded: Blob | undefined;
let downloadName = '';
const realCreate = dom.window.URL.createObjectURL;
dom.window.URL.createObjectURL = (blob: Blob) => { downloaded = blob; return 'blob:test'; };
const anchorClick = dom.window.HTMLAnchorElement.prototype.click;
dom.window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { downloadName = this.download; };
const logButton = [...doc.querySelectorAll<HTMLButtonElement>('#devices-panel button')]
  .find((b) => b.textContent === 'Download Bluetooth log');
const logSection = logButton?.closest<HTMLElement>('.device-diagnostics');
const debugDefault = settings.current.debugMode;
settings.patch({ debugMode: false });
const hiddenWithoutDebug = logSection?.hidden === true;
settings.patch({ debugMode: true });
const shownInDebug = logSection?.hidden === false;
logButton?.click();
settings.patch({ debugMode: debugDefault });
const downloadedText = downloaded
  ? await new Promise<string>((resolve) => {
    const reader = new dom.window.FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(downloaded!);
  })
  : '';
dom.window.URL.createObjectURL = realCreate;
dom.window.HTMLAnchorElement.prototype.click = anchorClick;

suite('the Bluetooth log can be downloaded from the devices panel, in debug mode', () => {
  check('the button is there', logButton !== undefined);
  check('hidden unless debug mode is on', hiddenWithoutDebug);
  check('shown in debug mode', shownInDebug);
  check('a .txt file is offered', /^cycle-indoors-ble-.*\.txt$/.test(downloadName), downloadName);
  check('it holds exactly the logged lines', downloadedText === bleLog.toText(), downloadedText.slice(0, 120));
  check('including this run\'s control traffic', /fitnessMachineControlPoint/.test(downloadedText),
    downloadedText.slice(0, 120));
});

report();
settings.patch({ useMockDevices: simulatorDefault });
session.dispose();
dom.window.close();
