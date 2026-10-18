const { DEFAULT_BIKE, speedForPower, stepSpeed } = await import('../src/devices/physics');
const { check, near, report, suite } = await import('./harness');

const model = (grade: number) => ({ ...DEFAULT_BIKE, mass: 83, grade });

/** Ride for a while at constant power, 60 fps, and return the speed reached. */
function ride(v: number, watts: number, grade: number, seconds: number): number {
  for (let t = 0; t < seconds; t += 1 / 60) v = stepSpeed(v, watts, 1 / 60, model(grade));
  return v;
}

suite('stepSpeed settles where the steady-state model says', () => {
  near('200 W on the flat', ride(0, 200, 0, 180), speedForPower(200, model(0)), 0.05);
  near('200 W at +8%', ride(0, 200, 8, 180), speedForPower(200, model(8)), 0.05);
  near('150 W at -5%', ride(0, 150, -5, 240), speedForPower(150, model(-5)), 0.1);
  near('one long step equals many short ones', stepSpeed(5, 200, 0.5, model(3)), (() => {
    let v = 5;
    for (let i = 0; i < 5; i++) v = stepSpeed(v, 200, 0.1, model(3));
    return v;
  })(), 1e-9);
});

suite('gradient changes speed the way a road does', () => {
  const flat = ride(0, 200, 0, 180);
  check('uphill is slower than flat', ride(0, 200, 8, 180) < flat * 0.5);
  check('downhill is faster than flat', ride(0, 150, -5, 240) > ride(0, 150, 0, 240));
});

suite('coasting', () => {
  const start = 30 / 3.6;
  const after = ride(start, 0, 0, 5);
  check('0 W on the flat slows down', after < start && after > 0, String(after));
  check('it comes to rest and never goes negative', ride(start, 0, 0, 600) === 0);
  check('it stays stopped on the flat', stepSpeed(0, 0, 1, model(0)) === 0);
  check('it stays stopped on a gentle descent', stepSpeed(0, 0, 1, model(-0.2)) === 0);
  check('0 W on a -6% descent picks up speed from rest', ride(0, 0, -6, 10) > 3);
  check('negative watts are treated as none', stepSpeed(5, -100, 1, model(0)) === stepSpeed(5, 0, 1, model(0)));
});

suite('inertia', () => {
  const flat = ride(0, 200, 0, 180);
  const climb = speedForPower(200, model(10));
  const afterOne = ride(flat, 200, 10, 1);
  check('one second into a 10% wall the rider is still well above climbing speed',
    afterOne > climb + (flat - climb) * 0.5, `${afterOne} vs ${climb}`);
  near('after a minute it has settled', ride(flat, 200, 10, 60), climb, 0.1);
  check('it does not overshoot below climbing speed', ride(flat, 200, 10, 60) >= climb - 0.01);
});

report();
