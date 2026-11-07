import { setupDom } from './dom-setup';
setupDom();

const { Course } = await import('../src/activity/course');
const { DEFAULT_BIKE, speedForPower } = await import('../src/devices/physics');
const { settings } = await import('../src/core/settings');
const { Playback, POWER_DEFAULT, POWER_MIN, POWER_MAX } = await import('../src/scene/playback');
const { check, near, report, suite } = await import('./harness');
const { trackFromLocal, eastbound } = await import('./scene-fixtures');

const mass = settings.current.riderWeight + settings.current.bikeWeight;

suite('playback: power', () => {
  const pb = new Playback(new Course(trackFromLocal(eastbound(1000))), mass);
  check('starts at 200 W', pb.power === POWER_DEFAULT && POWER_DEFAULT === 200);
  pb.setPower(20);
  check('no lower than 80 W', pb.power === POWER_MIN && POWER_MIN === 80);
  pb.setPower(900);
  check('no higher than 450 W', pb.power === POWER_MAX && POWER_MAX === 450);
  check('starts paused, at 1×', !pb.playing && pb.fastForward === 1);
  check('nothing moves while paused', pb.step(1) === 0 && pb.distance === 0);
});

suite('playback: climbing is slower', () => {
  // 1 km flat, then 3 km at 8%
  const course = new Course(trackFromLocal(eastbound(4000, (d) => (d < 1000 ? 100 : 100 + (d - 1000) * 0.08))));
  const pb = new Playback(course, mass);
  pb.play();
  let flatSpeed = 0;
  // the ride's own gradient over the last 30 s: Course smooths a synthetic
  // 8% line to between 8.0% and 8.9%, and speed follows what the ride reads
  const recent: number[] = [];
  for (let f = 0; f < 60 * 60 * 30 && pb.distance < 2500; f++) {
    pb.step(1 / 60);
    if (pb.distance < 900) flatSpeed = pb.speed;
    recent.push(pb.gradient());
    if (recent.length > 30 * 60) recent.shift();
  }
  const grade = recent.reduce((a, b) => a + b, 0) / recent.length;
  const want = speedForPower(200, { ...DEFAULT_BIKE, mass, grade });
  check('the rider got well onto the climb', pb.distance >= 2500, `${pb.distance.toFixed(0)} m`);
  near('the climb reads about 8%', grade, 8, 1);
  check('the flat was faster', flatSpeed > pb.speed * 1.5, `${(flatSpeed * 3.6).toFixed(1)} vs ${(pb.speed * 3.6).toFixed(1)} km/h`);
  near('on the climb speed settles at what the ride\'s physics gives for 200 W there, km/h', pb.speed * 3.6, want * 3.6, want * 3.6 * 0.02);
  near('the gradient read is the ride\'s own', pb.gradient(), course.at(pb.distance).gradient, 1e-9);
});

suite('playback: fast-forward', () => {
  const course = new Course(trackFromLocal(eastbound(30000)));
  const v = speedForPower(200, { ...DEFAULT_BIKE, mass, grade: 0 });
  const go = (ff: 1 | 4 | 16) => {
    const pb = new Playback(course, mass);
    pb.fastForward = ff;
    pb.speed = v; // already at a steady speed, so only the clock differs
    pb.play();
    for (let f = 0; f < 600; f++) pb.step(1 / 60);
    return pb.distance;
  };
  const one = go(1);
  near('16× covers 16 times the distance of 1× in the same 10 s, within 1%', go(16) / one, 16, 0.16);
  near('4× covers 4 times', go(4) / one, 4, 0.04);
  const pb = new Playback(course, mass);
  pb.play();
  pb.step(30);
  check('a stalled 30 s frame does not fling the rider ahead', pb.distance < 10, `${pb.distance.toFixed(1)} m`);
});

suite('playback: the finish', () => {
  const pb = new Playback(new Course(trackFromLocal(eastbound(500))), mass);
  pb.play();
  for (let f = 0; f < 60 * 300 && pb.playing; f++) pb.step(1 / 60);
  check('stops by itself', !pb.playing);
  near('exactly at the finish', pb.distance, pb.total, 1e-9);
  pb.play();
  check('Play starts again from the start', pb.playing && pb.distance === 0 && pb.speed === 0);
});

suite('playback: a jump', () => {
  const pb = new Playback(new Course(trackFromLocal(eastbound(20000))), mass);
  pb.jump(15400);
  check('sets the distance exactly', pb.distance === 15400, `${pb.distance}`);
  pb.jump(-50);
  check('no further back than the start', pb.distance === 0);
  pb.jump(1e9);
  check('no further on than the finish', pb.distance === pb.total);
});

report();
