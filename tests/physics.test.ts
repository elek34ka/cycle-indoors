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

report();
