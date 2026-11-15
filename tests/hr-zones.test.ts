const { HR_ZONES, zoneForHr, hrZoneColor } = await import('../src/core/zones');
const { computeMetrics } = await import('../src/session/metrics');
const { check, report, suite } = await import('./harness');
import type { Sample } from '../src/session/metrics';

/** One sample a second, with the heart rate `hr(t)` gives (undefined for no reading). */
const ride = (seconds: number, hr: (t: number) => number | undefined): Sample[] =>
  Array.from({ length: seconds }, (_, i) => ({
    t: i + 1, power: 200, targetPower: 0, heartRate: hr(i), distance: i * 8,
  }));
const zoneSeconds = (samples: Sample[], hrMax?: number) =>
  computeMetrics(samples, 250, hrMax).hrZones.map((z) => z.seconds);

/** `hrZoneColor` as it was before the zones had labels, to prove the trace colour did not move. */
function previousHrZoneColor(bpm: number, hrMax: number): string {
  const bounds = [
    { max: 0.60, color: '#7a8694' },
    { max: 0.70, color: '#3f8fd8' },
    { max: 0.80, color: '#3fc07a' },
    { max: 0.90, color: '#f08a35' },
    { max: Infinity, color: '#e4563c' },
  ];
  const r = hrMax > 0 ? bpm / hrMax : 0;
  for (const z of bounds) if (r <= z.max) return z.color;
  return '#e4563c';
}

suite('time in heart-rate zones', () => {
  const steady = ride(900, (i) => (i < 600 ? 140 : 160));
  check('600 s at 140 and 300 s at 160 bpm, max 185: Z3 10:00, Z4 5:00, nothing else',
    zoneSeconds(steady, 185).join() === '0,0,600,300,0', zoneSeconds(steady, 185).join());

  const dropped = ride(3600, (i) => (i < 2400 ? 150 : undefined));
  const total = zoneSeconds(dropped, 185).reduce((a, b) => a + b, 0);
  check('a strap that drops out after 40 of 60 minutes adds up to 40:00', total === 2400, String(total));

  const zeros = ride(600, (i) => (i % 2 ? 0 : 150));
  check('a reading of 0 bpm is no reading',
    zoneSeconds(zeros, 185).reduce((a, b) => a + b, 0) === 300);

  check('no heart rate: every zone 0:00', zoneSeconds(ride(600, () => undefined), 185).every((s) => s === 0));
  check('no max HR given: every zone 0:00', zoneSeconds(steady).every((s) => s === 0));

  const m = computeMetrics(steady, 250, 185);
  check('zones carry their labels and colours',
    m.hrZones.map((z) => z.label).join() === HR_ZONES.map((z) => z.label).join()
      && m.hrZones.every((z, i) => z.color === HR_ZONES[i].color && z.zone === i + 1));
  check('power zones are unaffected by max HR',
    JSON.stringify(m.zones) === JSON.stringify(computeMetrics(steady, 250).zones));
});

report();
