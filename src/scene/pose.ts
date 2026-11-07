/**
 * Where the first-person view faces: a heading that turns round gradually,
 * never straight from the road's own direction, which flips at a U-turn, and
 * the drawn road's pitch. The view never rolls; the renderer keeps its up
 * vertical.
 *
 * Heading is radians of atan2(z, x) in scene space (x east, z south), so a
 * growing heading turns right. Pitch is positive nose up.
 */

export type Vec3 = [number, number, number];

/** 180° per second of playback: a reversal takes at least a second at 1×. */
export const MAX_TURN_RATE = Math.PI;
/** never more than this in one frame, however long the frame */
const MAX_TURN_PER_FRAME = (80 * Math.PI) / 180;
export const MAX_PITCH = (45 * Math.PI) / 180;

export interface PoseInput {
  /** the road's own heading at the rider */
  heading: number;
  /** drawn rise over run at the rider, exaggeration applied */
  slope: number;
  /** seconds of playback this frame: wall time × fast-forward */
  dt: number;
}

const wrap = (a: number) => {
  let r = (a + Math.PI) % (2 * Math.PI);
  if (r < 0) r += 2 * Math.PI;
  return r - Math.PI;
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class ViewPose {
  heading = 0;
  pitch = 0;
  /** the way the last turn went, so a reversal of exactly 180° keeps going the same way */
  private turning = 1;

  /** Jump straight to a place on the road, as on a jump or at the start. */
  reset(heading: number, slope: number): void {
    this.heading = heading;
    this.pitch = clamp(Math.atan(slope), -MAX_PITCH, MAX_PITCH);
    this.turning = 1;
  }

  step(input: PoseInput): void {
    const dt = Math.max(0, input.dt);
    let diff = wrap(input.heading - this.heading);
    // a reversal reads as +180° or −180° from one frame to the next; keep
    // turning the way the turn started instead of flickering between them
    if (Math.abs(Math.abs(diff) - Math.PI) < 0.05) diff = this.turning * Math.abs(diff);
    const limit = Math.min(MAX_TURN_RATE * dt, MAX_TURN_PER_FRAME);
    const turn = clamp(diff, -limit, limit);
    if (Math.abs(turn) > 1e-6) this.turning = Math.sign(turn);
    this.heading = wrap(this.heading + turn);
    this.pitch = clamp(Math.atan(input.slope), -MAX_PITCH, MAX_PITCH);
  }
}
