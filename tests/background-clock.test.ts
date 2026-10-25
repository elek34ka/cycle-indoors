import { setupDom } from './dom-setup';
setupDom();

const { Emitter } = await import('../src/core/pubsub');
const { DeviceHub } = await import('../src/devices/hub');
const { Session } = await import('../src/session/session');
const { parseZwo } = await import('../src/workout/zwo');
const { settings } = await import('../src/core/settings');
const { courseStore } = await import('../src/activity/course-store');
const { check, near, report, suite } = await import('./harness');
import type { Device, DeviceStatus, Telemetry } from '../src/devices/types';
import { FakeBluetoothDevice, bytes, u16le, u32le } from './fake-gatt';

const { FtmsTrainer } = await import('../src/devices/ble/ftms');
const { CHARACTERISTIC, SERVICE } = await import('../src/devices/ble/uuids');

// A hidden tab gets no animation frames at all, and jsdom's never stop, so the
// frame loop is switched off here and the clock is moved by hand. Restored at
// the end: every test file shares these globals.
const realRaf = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = () => 0;

settings.patch({ ftp: 200, smoothPowerSeconds: 0 });
courseStore.unload();

const bus = new Emitter<{ data: Telemetry; status: DeviceStatus }>();
const trainer: Device = {
  id: 'hidden-trainer', label: 'Hidden trainer', roles: ['trainer', 'power', 'speed'], transport: 'mock',
  status: 'connected', connect: async () => {}, disconnect: async () => {},
  onTelemetry: (h) => bus.on('data', h), onStatus: (h) => bus.on('status', h),
};
const hub = new DeviceHub();
hub.register(trainer);

/** A session on a clock that only moves when told to. */
function rig() {
  let ms = 1_000;
  const session = new Session(hub, undefined, () => ms);
  bus.emit('data', { power: 200, speed: 36 });
  return { session, skip: (seconds: number) => { ms += seconds * 1000; } };
}

suite('a 30 s hidden gap is ridden in full', () => {
  const { session, skip } = rig();
  session.start();
  skip(30);
  session.advance();
  const s = session.snapshot;
  near('elapsed time grew by 30 s', s.elapsed, 30, 1);
  check('one sample per second of it', s.samples.length === 30, String(s.samples.length));
  check('every sample carries the live power', s.samples.every((x) => x.power === 200));
  near('distance grew at the trainer’s 36 km/h', s.distance, 300, 5);
  session.dispose();
});

suite('a suspended machine is not credited', () => {
  const { session, skip } = rig();
  session.start();
  skip(10);
  session.advance();
  const before = session.snapshot;
  const [elapsed, samples] = [before.elapsed, before.samples.length];
  skip(40 * 60);
  session.advance();
  const after = session.snapshot;
  check('elapsed time did not move', after.elapsed === elapsed, `${elapsed} → ${after.elapsed}`);
  check('no samples were invented', after.samples.length === samples, `${samples} → ${after.samples.length}`);
  skip(5);
  session.advance();
  near('and the ride carries on from there', session.snapshot.elapsed, elapsed + 5, 0.01);
  session.dispose();
});

suite('a pause spent hidden does not count', () => {
  const { session, skip } = rig();
  session.start();
  skip(10);
  session.advance();
  session.pause();
  skip(30);
  session.start();
  session.advance();
  near('only the 10 ridden seconds count', session.snapshot.elapsed, 10, 0.01);
  session.dispose();
});

suite('a block boundary inside one gap lands at the block’s start', () => {
  const { session, skip } = rig();
  session.loadWorkout(parseZwo(
    `<workout_file><name>Step</name><workout>
       <SteadyState Duration="20" Power="0.75"/>
       <SteadyState Duration="600" Power="1.25"/>
     </workout></workout_file>`,
    { ftp: settings.current.ftp },
  ));
  session.start();
  skip(30);
  session.advance();
  const s = session.snapshot;
  check('the first block closed as a lap', s.laps.length === 1, String(s.laps.length));
  near('at its 20 s boundary', s.laps[0]?.endTime ?? -1, 20, 0.5);
  check('samples before the boundary targeted 150 W', s.samples[10]?.targetPower === 150, String(s.samples[10]?.targetPower));
  check('and after it 250 W', s.samples[25]?.targetPower === 250, String(s.samples[25]?.targetPower));
  check('the snapshot is in the second block', s.targetPower === 250, String(s.targetPower));
  session.dispose();
});

suite('with no frames, sensor packets alone keep the ride going', () => {
  const { session, skip } = rig();
  session.start();
  for (let i = 0; i < 10; i++) {
    skip(1);
    bus.emit('data', { power: 220, speed: 36 });
  }
  const s = session.snapshot;
  near('ten one-second packets made ten seconds', s.elapsed, 10, 0.01);
  check('and ten samples', s.samples.length === 10, String(s.samples.length));
  check('each with the packet that ended its second', s.samples.every((x) => x.power === 220),
    s.samples.map((x) => x.power).join(','));
  session.dispose();
});

suite('coming back to the tab shows the caught-up ride at once', () => {
  const { session, skip } = rig();
  session.start();
  let shown = -1;
  session.on('tick', (snap) => { shown = snap.elapsed; });
  skip(20);
  document.dispatchEvent(new window.Event('visibilitychange'));
  near('the tick on return already holds the 20 s', shown, 20, 0.01);
  session.dispose();
});

suite('a disposed session stops listening', () => {
  const { session, skip } = rig();
  session.start();
  session.dispose();
  skip(5);
  bus.emit('data', { power: 200, speed: 36 });
  document.dispatchEvent(new window.Event('visibilitychange'));
  check('its clock did not move', session.snapshot.elapsed === 0, String(session.snapshot.elapsed));
});

// The real FTMS stack over the fake GATT: with no frames and no timers let
// run, the next block's target must still reach the trainer, carried by the
// trainer's own notifications.
{
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');

  const bt = new FakeBluetoothDevice('hidden-ftms', 'Hidden FTMS');
  const ftms = bt.service(SERVICE.fitnessMachine);
  const bikeData = ftms.add(CHARACTERISTIC.indoorBikeData);
  ftms.add(CHARACTERISTIC.fitnessMachineStatus);
  ftms.add(CHARACTERISTIC.fitnessMachineControlPoint).onWrite =
    (w) => new DataView(Uint8Array.of(0x80, w[0], 0x01).buffer);
  ftms.add(CHARACTERISTIC.fitnessMachineFeature, bytes(...u32le((1 << 1) | (1 << 14)), ...u32le((1 << 3) | (1 << 13))));
  ftms.add(CHARACTERISTIC.supportedPowerRange, bytes(...u16le(0), ...u16le(2000), ...u16le(1)));
  const ftmsHub = new DeviceHub();
  const ftmsTrainer = new FtmsTrainer(bt as unknown as BluetoothDevice);
  ftmsHub.register(ftmsTrainer);
  await ftmsTrainer.connect();
  await wait(60);

  let ms = 1_000;
  const session = new Session(ftmsHub, undefined, () => ms);
  const control = bt.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineControlPoint)!;
  session.loadWorkout(parseZwo(
    `<workout_file><name>Step</name><workout>
       <SteadyState Duration="20" Power="0.75"/>
       <SteadyState Duration="600" Power="1.25"/>
     </workout></workout_file>`,
    { ftp: settings.current.ftp },
  ));
  session.start();
  await settle();
  const before = control.writes.length;

  // Speed present (bit 0 clear), power present (bit 6): 36 km/h, 200 W.
  const packet = new DataView(bytes(0x40, 0x00, ...u16le(3600), ...u16le(200)).buffer);
  // Hidden-tab throttling, at its worst: no timer fires at all meanwhile.
  const [realSetTimeout, realWindowSetTimeout] = [globalThis.setTimeout, window.setTimeout];
  const held = (() => 0) as unknown as typeof setTimeout;
  globalThis.setTimeout = held;
  window.setTimeout = held;
  for (let i = 0; i < 25; i++) {
    ms += 1000;
    bikeData.notify(packet);
    await settle();
  }
  globalThis.setTimeout = realSetTimeout;
  window.setTimeout = realWindowSetTimeout;
  const sent = control.writes.slice(before).map(hex);

  suite('a block change while hidden reaches the trainer without frames or timers', () => {
    near('the ride advanced on notifications alone', session.snapshot.elapsed, 25, 0.01);
    check('Set Target Power 250 W was written', sent.includes('05 fa 00'), sent.join(' | '));
    check('and it is the last thing the trainer was told', sent[sent.length - 1] === '05 fa 00', sent.join(' | '));
  });
  session.dispose();
  await ftmsTrainer.disconnect();
}

globalThis.requestAnimationFrame = realRaf;
report();
