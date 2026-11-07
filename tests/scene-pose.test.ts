import { setupDom } from './dom-setup';
setupDom();

const { Course } = await import('../src/activity/course');
const { buildGeometry } = await import('../src/scene/geometry');
const { buildViewProfile } = await import('../src/scene/view-profile');
const { buildPasses, drawnAt } = await import('../src/scene/passes');
const { ViewPose, MAX_PITCH } = await import('../src/scene/pose');
const { check, report, suite } = await import('./harness');
const { trackFromLocal, outAndBack, eastbound, walk } = await import('./scene-fixtures');
import type { LocalPoint } from './scene-fixtures';

const deg = (r: number) => (r * 180) / Math.PI;
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

interface Run { startHeading: number; endHeading: number; frames: number; worstTurn: number; turningSeconds: number; worstPitchError: number; worstPitch: number }

/** Rides the drawn road at a constant speed, `ff` × real time at 60 fps, from `from` to `to`. */
function ride(points: LocalPoint[], speed: number, ff: number, exaggeration = 1, from = 0, to = Infinity, jumpAt?: number, jumpTo?: number): Run {
  const course = new Course(trackFromLocal(points));
  const g = buildGeometry(course);
  const p = buildPasses(g, buildViewProfile(course, g));
  const pose = new ViewPose();
  const dt = (1 / 60) * ff;
  let d = from;
  const start = drawnAt(g, p, d);
  pose.reset(start.heading, start.slope * exaggeration);
  const run: Run = { startHeading: pose.heading, endHeading: 0, frames: 0, worstTurn: 0, turningSeconds: 0, worstPitchError: 0, worstPitch: 0 };
  const end = Math.min(to, g.total);
  let jumped = false;
  while (d < end) {
    d = Math.min(end, d + speed * dt);
    let cut = false;
    if (jumpAt !== undefined && !jumped && d >= jumpAt) { d = jumpTo!; jumped = true; cut = true; }
    const at = drawnAt(g, p, d);
    const before = pose.heading;
    if (cut) pose.reset(at.heading, at.slope * exaggeration);
    else pose.step({ heading: at.heading, slope: at.slope * exaggeration, dt });
    const turn = Math.abs(wrap(pose.heading - before));
    if (!cut) run.worstTurn = Math.max(run.worstTurn, turn);
    if (turn > 1e-6 && !cut) run.turningSeconds += dt / ff;
    run.worstPitch = Math.max(run.worstPitch, Math.abs(pose.pitch));
    const want = Math.atan(at.slope * exaggeration);
    if (Math.abs(want) < MAX_PITCH) run.worstPitchError = Math.max(run.worstPitchError, Math.abs(pose.pitch - want));
    run.frames++;
  }
  run.endHeading = pose.heading;
  return run;
}

function common(name: string, r: Run) {
  check(`${name}: pitch never beyond 45°, so the view never tips over`, r.worstPitch <= MAX_PITCH + 1e-9, `${deg(r.worstPitch).toFixed(1)}°`);
  check(`${name}: heading changes less than 90° between frames`, r.worstTurn < Math.PI / 2, `${deg(r.worstTurn).toFixed(1)}°`);
  check(`${name}: pitch within 3° of the drawn slope`, r.worstPitchError <= (3 * Math.PI) / 180, `${deg(r.worstPitchError).toFixed(2)}°`);
}

suite('pose: a U-turn at the top of an out-and-back', () => {
  const route = outAndBack(800, 8, 1);
  for (const ff of [1, 16]) {
    // around the top only, so the turning time is the U-turn's
    const r = ride(route, 8, ff, 2.5, 700, 1000);
    common(`${ff}×`, r);
    // the turn is 180°, at no more than 180° per second of playback
    check(`${ff}×: the rider ends up facing back down`, Math.abs(Math.abs(wrap(r.endHeading - r.startHeading)) - Math.PI) < 0.05,
      `${deg(wrap(r.endHeading - r.startHeading)).toFixed(1)}°`);
    check(`${ff}×: the U-turn takes at least 1 s of 1× playback`, r.turningSeconds * ff >= 1 - 1e-6, `${(r.turningSeconds * ff).toFixed(2)} s`);
  }
});

suite('pose: a 20 m radius bend at 40 km/h', () => {
  // 200 m east, a right-hand 180° bend of radius 20 m, 200 m back west
  const route = walk(200 + Math.PI * 20 + 200, (d) => (d < 200 ? 0 : d < 200 + Math.PI * 20 ? (d - 200) / 20 : Math.PI), () => 100, 2);
  for (const ff of [1, 16]) {
    const r = ride(route, 40 / 3.6, ff);
    common(`${ff}×`, r);
    check(`${ff}×: turns round with the road`, Math.abs(Math.abs(wrap(r.endHeading - r.startHeading)) - Math.PI) < 0.05,
      `${deg(wrap(r.endHeading - r.startHeading)).toFixed(1)}°`);
  }
});

suite('pose: a 30% wall at 4× exaggeration', () => {
  const route = eastbound(2000, (d) => (d < 800 ? 100 : d < 1000 ? 100 + (d - 800) * 0.3 : 160));
  for (const ff of [1, 16]) {
    const r = ride(route, 4, ff, 4);
    common(`${ff}×`, r);
  }
});

suite('pose: a jump', () => {
  // jump from the way up to the way down of an out-and-back, a 180° change at once
  const r = ride(outAndBack(800, 8, 1), 8, 1, 2.5, 0, 1500, 300, 1400);
  common('jump', r);
});

suite('pose: no roll left to get wrong', () => {
  const pose = new ViewPose();
  check('the pose is a heading and a pitch only', JSON.stringify(Object.keys(pose).sort()) === JSON.stringify(['heading', 'pitch', 'turning']),
    Object.keys(pose).join(', '));
});

report();
