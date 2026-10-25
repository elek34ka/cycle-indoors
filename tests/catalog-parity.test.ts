import { readFileSync } from 'node:fs';
import { setupDom } from './dom-setup';
setupDom();

// The spec's promise: what the Library says about a file is what the ride will
// be. The catalog is built in Node; the ride loads the same bytes through
// `loadFile` in the browser. These must agree for every kind of file.
const { buildCatalog } = await import('../src/catalog/build');
const { loadFile } = await import('../src/loaders');
const { Course } = await import('../src/activity/course');
const { buildActivityFit } = await import('../src/activity/fit-export');
const { computeMetrics } = await import('../src/session/metrics');
const { FitEncoder } = await import('../src/fit/encoder');
const { toFitTime } = await import('../src/fit/crc');
const { check, near, report, suite } = await import('./harness');

const enc = (s: string) => new TextEncoder().encode(s);

function fitWorkout(): Uint8Array {
  const e = new FitEncoder();
  e.message(0, 0, [
    { num: 0, type: 'enum', value: 5 },
    { num: 1, type: 'uint16', value: 255 },
    { num: 4, type: 'uint32', value: toFitTime(new Date('2026-10-17T06:00:00Z')) },
  ]);
  e.message(1, 26, [
    { num: 8, type: 'string', value: 'FIT steady', size: 16 },
    { num: 4, type: 'enum', value: 2 },
    { num: 6, type: 'uint16', value: 2 },
  ]);
  const steps = [
    { index: 0, ms: 600_000, low: 55, high: 65 },
    { index: 1, ms: 1_200_000, low: 1230, high: 1250 }, // absolute watts: 230-250 W
  ];
  for (const s of steps) {
    e.message(2, 27, [
      { num: 254, type: 'uint16', value: s.index },
      { num: 0, type: 'string', value: '', size: 16 },
      { num: 1, type: 'enum', value: 0 },
      { num: 2, type: 'uint32', value: s.ms },
      { num: 3, type: 'enum', value: 4 },
      { num: 4, type: 'uint32', value: 0 },
      { num: 5, type: 'uint32', value: s.low },
      { num: 6, type: 'uint32', value: s.high },
      { num: 7, type: 'enum', value: 0 },
    ]);
  }
  return e.finish();
}

function fitRoute(): Uint8Array {
  const samples = [];
  let distance = 0;
  for (let t = 1; t <= 400; t++) {
    distance += 8;
    samples.push({
      t, power: 200, targetPower: 0, speed: 28.8, distance,
      lat: 41.6 + t * 0.00007, lon: 41.6 + t * 0.00002, altitude: 10 + Math.sin(t / 40) * 15,
    });
  }
  return buildActivityFit({
    startedAt: new Date('2026-10-17T07:30:00Z'), samples, laps: [], metrics: computeMetrics(samples, 250), name: 'FIT route',
  });
}

const fixtures = [
  { path: 'workouts/vo2/forty_twenty.zwo', bytes: enc(`<workout_file><name>40/20</name><workout>
    <Warmup Duration="600" PowerLow="0.24982758" PowerHigh="0.72568965" pace="0"/>
    <IntervalsT Repeat="12" OnDuration="40" OffDuration="20" OnPower="1.2045" OffPower="0.55327582" pace="0"/>
    <Cooldown Duration="600" PowerLow="0.55327582" PowerHigh="0.24982758" pace="0"/></workout></workout_file>`) },
  { path: 'workouts/russian.zwo', bytes: enc(`<workout_file><workout>
    <Warmup Duration="600" PowerLow="0.4" PowerHigh="0.4"></Warmup>
    <SteadyState Duration="15" PowerLow="0.6" PowerHigh="0.6"></SteadyState>
    <FreeRide Duration="300"/></workout></workout_file>`) },
  { path: 'workouts/fit-steady.fit', bytes: fitWorkout() },
  { path: 'routes/sample-hilly-loop.gpx', bytes: new Uint8Array(readFileSync('samples/sample-hilly-loop.gpx')) },
  { path: 'routes/batumi.gpx', bytes: enc(`<?xml version="1.0" encoding="UTF-8"?><gpx><trk><name>исследуем ближайшие холмы</name><trkseg>
    <trkpt lat="41.6357150" lon="41.6062020"><ele>2.30</ele></trkpt>
    <trkpt lat="41.6346370" lon="41.6048960"><ele>12.06</ele></trkpt>
    <trkpt lat="41.6336370" lon="41.6038960"><ele>18.50</ele></trkpt></trkseg></trk></gpx>`) },
  { path: 'routes/fit-route.fit', bytes: fitRoute() },
];

const build = await buildCatalog(fixtures);
// The ride loads at the rider's FTP, not the build's; durations and route
// totals must not depend on it.
const loaded = await Promise.all(fixtures.map(async (f) => {
  const name = f.path.split('/').pop()!;
  return { f, result: await loadFile(new File([f.bytes as BlobPart], name), { ftp: 220 }) };
}));

suite('every fixture made it into the index', () => {
  check('no problems', build.problems.length === 0, JSON.stringify(build.problems));
  check('three workouts, three routes', build.index.workouts.length === 3 && build.index.routes.length === 3);
});

suite('index and loadFile agree', () => {
  for (const { f, result } of loaded) {
    const id = f.path.replace(/^workouts\//, 'workout:').replace(/^routes\//, 'route:').replace(/\.[^.]+$/, '');
    if (f.path.startsWith('workouts/')) {
      const entry = build.index.workouts.find((w) => w.id === id);
      check(`${f.path}: duration`, entry !== undefined && result.workout !== undefined
        && entry.duration === Math.round(result.workout.duration * 10) / 10,
        `${entry?.duration} vs ${result.workout?.duration}`);
      check(`${f.path}: one compact block per segment`, entry?.blocks.length === result.workout?.segments.length);
    } else {
      const entry = build.index.routes.find((r) => r.id === id);
      const course = new Course(result.track!);
      check(`${f.path}: listed`, entry !== undefined);
      near(`${f.path}: distance`, entry?.distance ?? NaN, course.totalDistance, 0.5);
      near(`${f.path}: ascent`, entry?.ascent ?? NaN, course.totalAscent, 0.5);
      check(`${f.path}: name`, entry?.name === course.name, `${entry?.name} vs ${course.name}`);
    }
  }
});

report();
