import { Decoder, Stream } from '@garmin/fitsdk';
import { buildActivityFit } from '../src/activity/fit-export';
import { decodeFit } from '../src/fit/decoder';
import { computeMetrics, normalisedPower, type Sample } from '../src/session/metrics';
import { check, near, report, suite } from './harness';

const FTP = 250;
const DURATION = 600;

/** A ride that alternates 60 s at 300 W with 60 s at 150 W. */
function buildSamples(): Sample[] {
  const samples: Sample[] = [];
  let distance = 0;
  for (let t = 1; t <= DURATION; t++) {
    const hard = Math.floor((t - 1) / 60) % 2 === 0;
    const power = hard ? 300 : 150;
    const speed = hard ? 36 : 26;
    distance += speed / 3.6;
    samples.push({ t, power, targetPower: power, heartRate: hard ? 160 : 132, cadence: hard ? 92 : 80, speed, distance });
  }
  return samples;
}

const samples = buildSamples();
const metrics = computeMetrics(samples, FTP);
const startedAt = new Date('2026-10-17T07:30:00Z');
const bytes = buildActivityFit({ startedAt, samples, laps: [], metrics, name: 'Round-trip test' });

suite('Garmin FIT SDK accepts the file', () => {
  const stream = Stream.fromByteArray(Array.from(bytes));
  check('SDK recognises it as FIT', Decoder.isFIT(stream));
  const decoder = new Decoder(stream);
  check('SDK integrity check passes', decoder.checkIntegrity());
  const { messages, errors } = decoder.read();
  check('SDK reports no errors', errors.length === 0, JSON.stringify(errors.slice(0, 2)));
  check('SDK sees all records', messages.recordMesgs?.length === DURATION, `got ${messages.recordMesgs?.length}`);
  check('SDK reads sport as cycling', messages.sessionMesgs?.[0]?.sport === 'cycling',
    `got ${messages.sessionMesgs?.[0]?.sport}`);
  check('SDK reads sub-sport as indoor cycling', messages.sessionMesgs?.[0]?.subSport === 'indoorCycling',
    `got ${messages.sessionMesgs?.[0]?.subSport}`);
  near('SDK reads avg power', messages.sessionMesgs?.[0]?.avgPower, 225, 0.01);
  near('SDK reads max heart rate', messages.sessionMesgs?.[0]?.maxHeartRate, 160, 0.01);
  check('SDK reads one lap', messages.lapMesgs?.length === 1, `got ${messages.lapMesgs?.length}`);
  const ts = messages.recordMesgs?.[0]?.timestamp;
  check('SDK reads the start timestamp', ts instanceof Date && Math.abs(ts.getTime() - (startedAt.getTime() + 1000)) < 1500,
    `got ${ts}`);
  check('SDK reads the product name', messages.fileIdMesgs?.[0]?.productName === 'Cycle Indoors',
    `got ${messages.fileIdMesgs?.[0]?.productName}`);
});

// ---- a ride that followed a GPS route ------------------------------------

/** 400 m of climbing road near Kraków, ridden at a steady 240 W. */
function buildRouteSamples(): Sample[] {
  const out: Sample[] = [];
  let distance = 0;
  for (let t = 1; t <= 300; t++) {
    distance += 8; // 28.8 km/h
    out.push({
      t,
      power: 240,
      targetPower: 240,
      heartRate: 150,
      cadence: 88,
      speed: 28.8,
      distance,
      lat: 50.06 + t * 0.0001,
      lon: 19.94 + t * 0.00005,
      altitude: 220 + t * 0.4,
    });
  }
  return out;
}

const routeSamples = buildRouteSamples();
const routeMetrics = computeMetrics(routeSamples, FTP);
const routeBytes = buildActivityFit({
  startedAt, samples: routeSamples, laps: [], metrics: routeMetrics, name: 'Route ride',
});

suite('metrics from a ride along a route', () => {
  check('position was detected', routeMetrics.hasPosition);
  near('ascent is the sum of the climb', routeMetrics.ascent, 299 * 0.4, 0.5);
  near('descent is zero on a pure climb', routeMetrics.descent, 0, 0.001);
  near('the start fix is the first sample', routeMetrics.startLat!, 50.0601, 0.0001);

  // A lap wrap teleports the rider back to the bottom of the course; that must
  // not be counted as a 100 m descent.
  const wrapped = computeMetrics([
    { t: 1, power: 200, targetPower: 0, distance: 0, altitude: 300 },
    { t: 2, power: 200, targetPower: 0, distance: 10, altitude: 302 },
    { t: 3, power: 200, targetPower: 0, distance: 20, altitude: 200 },
    { t: 4, power: 200, targetPower: 0, distance: 30, altitude: 201 },
  ], FTP);
  near('a course wrap is not counted as climbing', wrapped.ascent, 3, 0.001);
  near('nor as descending', wrapped.descent, 0, 0.001);
});

suite('Garmin FIT SDK reads the GPS track', () => {
  // The SDK returns position in raw semicircles and leaves the conversion to
  // degrees to the caller, so do it here.
  const degrees = (semicircles: number | undefined) =>
    semicircles === undefined ? NaN : semicircles * (180 / 2 ** 31);
  const decoder = new Decoder(Stream.fromByteArray(Array.from(routeBytes)));
  check('integrity check passes', decoder.checkIntegrity());
  const { messages, errors } = decoder.read();
  check('no decode errors', errors.length === 0, JSON.stringify(errors.slice(0, 2)));
  const record = messages.recordMesgs?.[0];
  near('SDK reads latitude in degrees', degrees(record?.positionLat), 50.0601, 0.0001);
  near('SDK reads longitude in degrees', degrees(record?.positionLong), 19.94005, 0.0001);
  near('SDK reads altitude in metres', record?.altitude, 220.4, 0.2);
  const session = messages.sessionMesgs?.[0];
  check('SDK names the sub-sport virtual activity', session?.subSport === 'virtualActivity',
    String(session?.subSport));
  near('SDK reads total ascent', session?.totalAscent, Math.round(routeMetrics.ascent), 1.5);
  near('SDK reads the start position', degrees(session?.startPositionLat), 50.0601, 0.0001);
  check('SDK reads one lap with its climb',
    messages.lapMesgs?.length === 1 && Math.abs((messages.lapMesgs[0].totalAscent ?? 0) - Math.round(routeMetrics.ascent)) <= 2,
    `laps ${messages.lapMesgs?.length}, ascent ${messages.lapMesgs?.[0]?.totalAscent}`);
});

report();
