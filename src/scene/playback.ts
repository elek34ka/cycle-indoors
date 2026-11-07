import type { Course } from '../activity/course';
import { DEFAULT_BIKE, stepSpeed } from '../devices/physics';

/**
 * Simulated riding for the 3D view: a fixed power through the ride's own
 * physics and the ride's own gradient (not the drawn one), so speed on a
 * climb is what the rider would see on the ride screen. Nothing here touches
 * the session or any trainer.
 */

export const POWER_MIN = 80;
export const POWER_MAX = 450;
export const POWER_DEFAULT = 200;
export const FAST_FORWARDS = [1, 4, 16] as const;
export type FastForward = (typeof FAST_FORWARDS)[number];

/** longest wall-clock frame counted: a stalled tab must not fling the rider ahead */
const MAX_FRAME = 0.25;

export class Playback {
  distance = 0;
  /** m/s */
  speed = 0;
  playing = false;
  power = POWER_DEFAULT;
  fastForward: FastForward = 1;
  readonly total: number;

  constructor(private readonly course: Course, private readonly mass: number) {
    this.total = course.totalDistance;
  }

  setPower(watts: number): void {
    this.power = Math.max(POWER_MIN, Math.min(POWER_MAX, Math.round(watts)));
  }

  /** Starts, or restarts from the beginning if the rider is at the finish. */
  play(): void {
    if (this.atFinish) { this.distance = 0; this.speed = 0; }
    this.playing = true;
  }

  pause(): void { this.playing = false; }

  get atFinish(): boolean { return this.distance >= this.total; }

  /** Moves the rider to `distance` exactly, keeping speed. */
  jump(distance: number): void {
    this.distance = Math.max(0, Math.min(this.total, distance));
  }

  /** The ride's gradient at the rider, percent. */
  gradient(): number {
    // course.at(total) wraps to the start, so the finish is read just before it
    return this.course.at(Math.min(this.distance, Math.max(0, this.total - 1e-6))).gradient;
  }

  /**
   * Advances by `wallSeconds` of real time, times the fast-forward. Returns
   * the playback seconds simulated, 0 when paused.
   */
  step(wallSeconds: number): number {
    if (!this.playing) return 0;
    const dt = Math.min(MAX_FRAME, Math.max(0, wallSeconds)) * this.fastForward;
    let remaining = dt;
    // short steps, so speed follows the gradient along the way at 16×
    while (remaining > 0 && !this.atFinish) {
      const h = Math.min(0.1, remaining);
      remaining -= h;
      this.speed = stepSpeed(this.speed, this.power, h, { ...DEFAULT_BIKE, mass: this.mass, grade: this.gradient() });
      this.distance = Math.min(this.total, this.distance + this.speed * h);
    }
    if (this.atFinish) { this.distance = this.total; this.playing = false; }
    return dt;
  }
}
