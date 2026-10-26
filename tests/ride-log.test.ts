const { rideLogEntry, MIN_LOGGED_SECONDS } = await import('../src/ride-log/entry');
const { computeMetrics } = await import('../src/session/metrics');
const { check, report, suite } = await import('./harness');
type Sample = import('../src/session/metrics').Sample;

/** A steady ride of `seconds`, with GPS positions climbing gently. */
function ride(seconds: number, gps = true): Sample[] {
  const samples: Sample[] = [];
  for (let t = 1; t <= seconds; t++) {
    samples.push({
      t, power: 200, targetPower: 200, heartRate: 140, cadence: 90, speed: 30, distance: t * 8.33,
      ...(gps ? { lat: 51 + t * 1e-5, lon: 0.1, altitude: 100 + t * 0.01 } : {}),
    });
  }
  return samples;
}

const startedAt = new Date(Date.UTC(2026, 4, 1, 7, 30));
const threeHours = computeMetrics(ride(3 * 3600), 250);
const entry = rideLogEntry({
  startedAt,
  metrics: threeHours,
  workout: { title: 'Sweet Spot 2x20', entry: { key: 'catalog:workout:sweetspot/2x20.zwo', title: 'Sweet Spot 2x20', sha256: 'f00d' } },
  route: { name: 'Hilly loop', entry: { key: 'mine:abc123', title: 'Hilly loop' } },
});

suite('a finished ride is logged as numbers', () => {
  check('logged', entry !== undefined);
  check('keyed by its start time', entry?.startedAt === startedAt.getTime());
  check('with duration, distance, power, NP, TSS, HR and ascent',
    entry?.duration === 3 * 3600 && entry.distance === Math.round(threeHours.distance)
      && entry.avgPower === 200 && entry.normalisedPower === Math.round(threeHours.normalisedPower)
      && entry.tss === Math.round(threeHours.tss * 10) / 10 && entry.avgHr === 140
      && entry.ascent === Math.round(threeHours.ascent), JSON.stringify(entry));
  check('names the catalog workout by its entry key and title',
    entry?.workout?.key === 'catalog:workout:sweetspot/2x20.zwo' && entry.workout.title === 'Sweet Spot 2x20');
  check('and the My library route by its entry key and name',
    entry?.route?.key === 'mine:abc123' && entry.route.name === 'Hilly loop');
  check('with the file\'s hash when the entry has one, so it can be found again',
    entry?.workout?.sha256 === 'f00d' && entry.route?.sha256 === undefined);
  const json = JSON.stringify(entry);
  check('a three-hour GPS ride stays under 1 KB', json.length < 1024, `${json.length} bytes`);
  check('no samples, track or positions in it', !/samples|lat|lon|points|bytes/.test(json), json);
});

const titleOnly = rideLogEntry({ startedAt, metrics: computeMetrics(ride(600, false), 250), workout: { title: 'From a file' } });

suite('a workout that is not in the Library', () => {
  check('is named by title only', titleOnly?.workout?.title === 'From a file' && titleOnly.workout.key === undefined);
  check('a ride without a route has none', titleOnly?.route === undefined);
  check('and no HR when nothing was measured', rideLogEntry({
    startedAt, metrics: computeMetrics(ride(600).map(({ heartRate: _, ...s }) => s), 250),
  })?.avgHr === undefined);
});

suite('a stray start is not logged', () => {
  check(`under ${MIN_LOGGED_SECONDS} s: nothing`, rideLogEntry({ startedAt, metrics: computeMetrics(ride(30), 250) }) === undefined);
  check('no samples at all: nothing', rideLogEntry({ startedAt, metrics: computeMetrics([], 250) }) === undefined);
  check(`a minute: logged`, rideLogEntry({ startedAt, metrics: computeMetrics(ride(MIN_LOGGED_SECONDS + 1), 250) }) !== undefined);
});

report();
