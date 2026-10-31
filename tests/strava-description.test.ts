const { stravaDescription, DESCRIPTION_CREDIT } = await import('../src/activity/strava-description');
const { summaryValues } = await import('../src/ui/summary-values');
const { computeMetrics } = await import('../src/session/metrics');
const { check, report, suite } = await import('./harness');
type Sample = import('../src/session/metrics').Sample;
type RideMetrics = import('../src/session/metrics').RideMetrics;

const ride = (seconds: number, opts: { route?: boolean; hr?: boolean; target?: number; power?: (t: number) => number } = {}): Sample[] =>
  Array.from({ length: seconds }, (_, t) => ({
    t: t + 1, power: opts.power?.(t) ?? 210, targetPower: opts.target ?? 0, cadence: 88, speed: 32.9, distance: (t + 1) * 9,
    ...(opts.hr === false ? {} : { heartRate: 150 + (t % 20) }),
    ...(opts.route ? { lat: 46 + t * 1e-5, lon: 7, altitude: 500 + t * 0.1 } : {}),
  }));

function describe(samples: Sample[], names: { route?: string; workout?: string } = {}): { text: string; m: RideMetrics } {
  const m = computeMetrics(samples, 250, 185);
  const text = stravaDescription({
    ...names,
    values: summaryValues(m, 0),
    ...(m.maxHr !== undefined ? { maxHr: Math.round(m.maxHr) } : {}),
    zones: m.zones,
    hrZones: m.hrZones,
  });
  return { text, m };
}
const lines = (text: string) => text.split('\n');

suite('the route and the workout come first', () => {
  const { text } = describe(ride(600, { route: true }), { route: 'Alpe Loop', workout: 'Sweet Spot 3x15' });
  check('route on line 1', lines(text)[0] === 'Route: Alpe Loop', lines(text)[0]);
  check('workout on line 2', lines(text)[1] === 'Workout: Sweet Spot 3x15', lines(text)[1]);
  check('then a blank line', lines(text)[2] === '');

  const workoutOnly = describe(ride(600), { workout: 'Sweet Spot 3x15' }).text;
  check('workout only: starts with the workout', lines(workoutOnly)[0] === 'Workout: Sweet Spot 3x15');
  check('and has no Route line', !workoutOnly.includes('Route:'));

  const free = describe(ride(600)).text;
  check('free ride: neither line', !free.includes('Route:') && !free.includes('Workout:'));
  check('never called Free ride', !free.includes('Free ride'));
  check('and no blank line to start', lines(free)[0] !== '', JSON.stringify(lines(free).slice(0, 2)));
  check('no empty name is ever printed', !describe(ride(600), { route: '', workout: '' }).text.includes(':  '));
});

suite('the numbers read as they do in the summary', () => {
  const { text, m } = describe(ride(3735, { route: true, target: 210 }), { workout: 'W' });
  const v = Object.fromEntries(summaryValues(m, 0).map((x) => [x.key, x.value]));
  check('duration and distance', text.includes(`Duration ${v.duration} · Distance ${v.distance} km`), text);
  check('power: avg, NP, max', text.includes(`Power avg ${v.avgPower} W · NP ${v.normalisedPower} W · max ${v.maxPower} W`));
  check('IF, TSS and work', text.includes(`IF ${v.intensity} · TSS ${v.tss} · Work ${v.work} kJ`));
  check('heart rate avg and max', text.includes(`Heart rate avg ${v.avgHr} bpm · max ${Math.round(m.maxHr!)} bpm`));
  check('cadence and speed', text.includes(`Cadence ${v.avgCadence} rpm · Speed ${v.avgSpeed} km/h`));
  check('climb and on-target', text.includes(`Climbed ${v.climbed} m · On target ${v.onTarget}`));
  check('the duration reads 1:02:15', v.duration === '1:02:15');
});

suite('values the ride does not have are left out', () => {
  const noHr = describe(ride(600, { hr: false })).text;
  check('no heart-rate line', !noHr.includes('Heart rate'));
  check('no heart-rate zone line', !noHr.includes('HR zones'));
  check('no -- anywhere', !noHr.includes('--'));
  const noRoute = describe(ride(600)).text;
  check('no climb without a route', !noRoute.includes('Climbed'));
  check('no on-target without a workout target', !noRoute.includes('On target'));
});

suite('time in zones lists only zones with time in them', () => {
  // 20:00 at 65% of 250 W (Z2), then 5:00 at 100% (Z4)
  const { text } = describe(ride(1500, { power: (t) => (t < 1200 ? 162 : 250) }));
  const power = lines(text).find((l) => l.startsWith('Power zones:'));
  check('Z2 20:00 and Z4 5:00, nothing else', power === 'Power zones: Z2 20:00 · Z4 5:00', power);
  const hr = lines(text).find((l) => l.startsWith('HR zones:'));
  check('heart-rate zones on their own line', hr !== undefined && /^HR zones: (Z\d \d+:\d\d)( · Z\d \d+:\d\d)*$/.test(hr), hr);
});

suite('a credit ends it', () => {
  for (const [name, text] of [
    ['a route ride', describe(ride(600, { route: true }), { route: 'R', workout: 'W' }).text],
    ['a free ride without heart rate', describe(ride(600, { hr: false })).text],
  ] as const) {
    check(`${name}: last line is the credit`, lines(text).at(-1) === DESCRIPTION_CREDIT);
    check(`${name}: set off by a blank line`, lines(text).at(-2) === '');
    check(`${name}: never two blank lines together`, !text.includes('\n\n\n'));
  }
  check('the credit reads Ridden on Cycle Indoors', DESCRIPTION_CREDIT === 'Ridden on Cycle Indoors');
});

report();
