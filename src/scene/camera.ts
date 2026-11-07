import type { Vec3 } from './pose';

/**
 * The first-person eye over the rider's point on the drawn road, facing the
 * pose's own smoothed heading (never the raw road direction, which flips at a
 * U-turn). It is never eased: it rides with the rider. Everything is in scene
 * units, heights already exaggerated.
 */

export const EYE_HEIGHT = 1.5;
/** how far ahead the eye looks, metres */
const LOOK_AHEAD = 15;
const MIN_CLEARANCE = 1;

export interface CameraInput {
  /** the rider's point on the road */
  rider: Vec3;
  /** the pose's heading, radians atan2(z, x) */
  heading: number;
  /** the pose's pitch, radians */
  pitch: number;
  /** drawn ground height at (x, z), in scene units */
  groundAt: (x: number, z: number) => number;
}

export interface CameraView { position: Vec3; target: Vec3 }

/** The eye 1.5 m over the rider, looking 15 m ahead and tilted by half the road's pitch. */
export function eyeView(rider: Vec3, heading: number, pitch: number): CameraView {
  const fx = Math.cos(heading);
  const fz = Math.sin(heading);
  const [x, y, z] = rider;
  return {
    position: [x, y + EYE_HEIGHT, z],
    target: [x + LOOK_AHEAD * fx, y + EYE_HEIGHT + LOOK_AHEAD * Math.tan(pitch / 2), z + LOOK_AHEAD * fz],
  };
}

/** The eye for this frame, lifted to stay at least 1 m above the drawn ground beneath it. */
export function firstPerson(input: CameraInput): CameraView {
  const view = eyeView(input.rider, input.heading, input.pitch);
  const floor = input.groundAt(view.position[0], view.position[2]) + MIN_CLEARANCE;
  if (view.position[1] < floor) {
    const lift = floor - view.position[1];
    view.position[1] += lift;
    view.target[1] += lift;
  }
  return view;
}
