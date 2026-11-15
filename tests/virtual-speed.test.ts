import { setupDom } from './dom-setup';
const dom = setupDom();

import { Decoder, Stream } from '@garmin/fitsdk';

const { Emitter } = await import('../src/core/pubsub');
const { DeviceHub } = await import('../src/devices/hub');
const { Session } = await import('../src/session/session');
const { courseStore } = await import('../src/activity/course-store');
const { settings } = await import('../src/core/settings');
const { buildActivityFit } = await import('../src/activity/fit-export');
const { computeMetrics } = await import('../src/session/metrics');
const { check, near, report, suite } = await import('./harness');
import type { Device, DeviceStatus, Telemetry } from '../src/devices/types';
import type { ActivityTrack, TrackPoint } from '../src/activity/types';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 5 km climbing steadily at 10%. */
function climb(): ActivityTrack {
  const points: TrackPoint[] = [];
  for (let d = 0; d <= 5000; d += 10) points.push({ lat: 50 + d / 111320, lon: 19, ele: 100 + d * 0.1, distance: d });
  return {
    name: 'Wall', source: 'gpx', points, distance: 5000, ascent: 500, descent: 0,
    hasPower: true, hasHr: false, hasElevation: true,
  };
}

// A read-only trainer that reports 200 W at a flat-road 35 km/h, the way a
// trainer in ERG does whatever the virtual road is doing.
const bus = new Emitter<{ data: Telemetry; status: DeviceStatus }>();
const trainer: Device = {
  id: 'flat-trainer', label: 'Flat trainer', roles: ['trainer', 'power', 'speed'], transport: 'mock',
  status: 'connected', connect: async () => {}, disconnect: async () => {},
  onTelemetry: (h) => bus.on('data', h), onStatus: (h) => bus.on('status', h),
};
const hub = new DeviceHub();
hub.register(trainer);
const feed = setInterval(() => bus.emit('data', { power: 200, speed: 35 }), 50);
bus.emit('data', { power: 200, speed: 35 });

settings.patch({ riderWeight: 75, bikeWeight: 8 });
const session = new Session(hub);
session.start();
await wait(1200);

const samplesBefore = session.snapshot.samples.length;
courseStore.load(climb());
await wait(400);
const early = session.snapshot.speed!;
const distanceEarly = session.snapshot.distance;
await wait(1600);

suite('on a 10% climb at 200 W the rider slows, whatever the trainer says', () => {
  const s = session.snapshot;
  check('it starts from the trainer speed rather than from zero', early > 30, String(early));
  check('it is slowing down', s.speed! < early, `${s.speed} after ${early}`);
  check('it is well below the flat-road speed', s.speed! < 33, String(s.speed));
  // the 30 m elevation smoothing softens the first metres of the route
  check('the gradient under the wheels is the climb', (s.coursePosition?.gradient ?? 0) > 5,
    String(s.coursePosition?.gradient));
  check('distance now advances more slowly than at 35 km/h',
    s.distance - distanceEarly < (35 / 3.6) * 1.6, String(s.distance - distanceEarly));
  const onRoute = s.samples.slice(samplesBefore + 1);
  check('recorded samples carry the virtual speed', onRoute.length > 0 && onRoute.every((x) => x.speed! < 35),
    JSON.stringify(onRoute.map((x) => x.speed)));
});

// A few more seconds on the climb, so the export has distance steps to compare.
await wait(1000);

suite('the exported ride carries the virtual speed, checked by Garmin\'s SDK', () => {
  const { samples } = session.snapshot;
  const bytes = buildActivityFit({
    startedAt: new Date('2026-10-18T07:00:00Z'), samples, laps: [],
    metrics: computeMetrics(samples, settings.current.ftp), name: 'Virtual speed',
  });
  const { messages, errors } = new Decoder(Stream.fromByteArray(Array.from(bytes))).read();
  check('the SDK decodes it without errors', errors.length === 0, String(errors));
  const records = messages.recordMesgs ?? [];
  check('one record per sample', records.length === samples.length, `${records.length} vs ${samples.length}`);
  const onRoute = records.slice(samplesBefore + 1);
  check('record speeds are the virtual speed', onRoute.every((r: { speed: number }, i: number) =>
    Math.abs(r.speed - samples[samplesBefore + 1 + i].speed! / 3.6) < 0.002),
    JSON.stringify(onRoute.map((r: { speed: number }) => r.speed)));
  check('record speeds are below the trainer\'s flat 35 km/h', onRoute.every((r: { speed: number }) => r.speed < 35 / 3.6));
  // Distance is the integral of the same speed, so each second's step matches
  // the mean of the speeds either side of it.
  const steps = onRoute.slice(1).map((r: { distance: number; speed: number }, i: number) =>
    Math.abs((r.distance - onRoute[i].distance) - (r.speed + onRoute[i].speed) / 2));
  check('distance steps match the recorded speed', steps.length > 0 && steps.every((d: number) => d < 0.5),
    JSON.stringify(steps));
  check('records carry the GPS position on the route', onRoute.every((r: { positionLat?: number }) => r.positionLat !== undefined));
});

report();
clearInterval(feed);
session.dispose();
dom.window.close();
