import { setupDom } from './dom-setup';
setupDom();

const { Course } = await import('../src/activity/course');
const { buildGeometry } = await import('../src/scene/geometry');
const { buildViewProfile } = await import('../src/scene/view-profile');
const { buildPasses, drawnAt } = await import('../src/scene/passes');
const { ViewPose, MAX_PITCH } = await import('../src/scene/pose');
const cameraModule = await import('../src/scene/camera');
const { EYE_HEIGHT, eyeView, firstPerson } = cameraModule;
const { check, near, report, suite } = await import('./harness');
const { trackFromLocal, outAndBack, eastbound } = await import('./scene-fixtures');
import type { Vec3 } from '../src/scene/pose';

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const deg = (r: number) => (r * 180) / Math.PI;
/** the view direction's angle above horizontal */
const tilt = (v: { position: Vec3; target: Vec3 }) => {
  const a = sub(v.target, v.position);
  return Math.atan2(a[1], Math.hypot(a[0], a[2]));
};

check('first person is the only view: no modes are offered', !('CAMERA_MODES' in cameraModule) && !('CameraRig' in cameraModule));

suite('camera: the eye', () => {
  const rider: Vec3 = [100, 50, -20];
  const fp = eyeView(rider, 0.7, 0.2);
  near('1.5 m above the road at the rider', fp.position[1] - rider[1], EYE_HEIGHT, 1e-9);
  near('… right over the rider', Math.hypot(fp.position[0] - rider[0], fp.position[2] - rider[2]), 0, 1e-9);
  const ahead = sub(fp.target, fp.position);
  near('… looking 15 m along the road', Math.hypot(ahead[0], ahead[2]), 15, 1e-9);
  near('… facing the heading', Math.atan2(ahead[2], ahead[0]), 0.7, 1e-9);
  near('… tilted by half the road\'s pitch', tilt(fp), 0.1, 1e-9);
  // the steepest the pose allows: the horizon stays level because the view
  // never gets near vertical, where a vertical up vector would degenerate
  check('at the steepest pitch the view is tilted at most 22.5°', Math.abs(tilt(eyeView(rider, 0, MAX_PITCH))) <= MAX_PITCH / 2 + 1e-9);
});

suite('camera: never in the ground', () => {
  // the rider on a road heading east (+x) at the origin; ground shapes around it
  const grounds: [string, (x: number, z: number) => number][] = [
    ['flat ground just under the road', () => -0.2],
    ['a hump under the rider', (x) => 1.5 - 0.01 * x * x],
    ['a narrow valley', (_x, z) => 1.5 * Math.abs(z) - 0.2],
  ];
  for (const [name, groundAt] of grounds) {
    let lowest = Infinity;
    for (let f = 0; f < 120; f++) {
      const rider: Vec3 = [f * (8 / 60) - 8, 0, 0];
      const view = firstPerson({ rider, heading: 0, pitch: 0, groundAt });
      lowest = Math.min(lowest, view.position[1] - groundAt(view.position[0], view.position[2]));
    }
    check(`${name}: at least 1 m above the ground`, lowest >= 1 - 1e-9, `${lowest.toFixed(2)} m`);
  }
  const lifted = firstPerson({ rider: [0, 0, 0], heading: 0, pitch: 0.2, groundAt: () => 3 });
  near('a lifted eye keeps its tilt', tilt(lifted), 0.1, 1e-9);
});

suite('camera: a jump lands at once', () => {
  const far: Vec3 = [15000, 30, 0];
  const view = firstPerson({ rider: far, heading: 1, pitch: 0, groundAt: () => -10 });
  check('the eye is over the new point on the first frame', Math.hypot(view.position[0] - far[0], view.position[2] - far[2]) < 1e-9);
});

suite('camera: through a U-turn', () => {
  const course = new Course(trackFromLocal(outAndBack(800, 8, 1)));
  const g = buildGeometry(course);
  const p = buildPasses(g, buildViewProfile(course, g));
  for (const ff of [1, 16]) {
    const pose = new ViewPose();
    const dt = ff / 60;
    let d = 650;
    const s = drawnAt(g, p, d);
    pose.reset(s.heading, s.slope * 2.5);
    let last: number | undefined;
    let worst = 0;
    let worstTilt = 0;
    while (d < 1050) {
      d += 8 * dt;
      const at = drawnAt(g, p, d);
      pose.step({ heading: at.heading, slope: at.slope * 2.5, dt });
      const view = firstPerson({ rider: [at.x, at.h * 2.5, at.z], heading: pose.heading, pitch: pose.pitch, groundAt: () => -1e3 });
      const dir = Math.atan2(view.target[2] - view.position[2], view.target[0] - view.position[0]);
      if (last !== undefined) worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(dir - last), Math.cos(dir - last))));
      worstTilt = Math.max(worstTilt, Math.abs(tilt(view)));
      last = dir;
    }
    check(`${ff}×: the view turns less than 90° between frames`, worst < Math.PI / 2, `${deg(worst).toFixed(1)}°`);
    check(`${ff}×: and stays within 22.5° of level`, worstTilt <= MAX_PITCH / 2 + 1e-9, `${deg(worstTilt).toFixed(1)}°`);
  }
});

suite('camera: a 20% drawn road at 4×', () => {
  const course = new Course(trackFromLocal(eastbound(1500, (d) => (d < 500 ? 100 : 100 + 0.2 * Math.min(800, d - 500)))));
  const g = buildGeometry(course);
  const p = buildPasses(g, buildViewProfile(course, g));
  const at = drawnAt(g, p, 900);
  const pose = new ViewPose();
  pose.reset(at.heading, at.slope * 4);
  const view = firstPerson({ rider: [at.x, at.h * 4, at.z], heading: pose.heading, pitch: pose.pitch, groundAt: () => -1e3 });
  near('the view tilts up by half the drawn road\'s angle', tilt(view), Math.atan(at.slope * 4) / 2, 1e-6);
  check('… which is up the hill', tilt(view) > 0.2, `${deg(tilt(view)).toFixed(1)}°`);
});

report();
