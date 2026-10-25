import { Emitter } from '../core/pubsub';
import { clamp } from '../core/format';
import { settings } from '../core/settings';
import { courseStore } from '../activity/course-store';
import type { CoursePosition } from '../activity/course';
import { hub, type DeviceHub } from '../devices/hub';
import { DEFAULT_BIKE, stepSpeed } from '../devices/physics';
import type { Telemetry } from '../devices/types';
import { segmentAt, targetRatioAt, type Segment, type Workout } from '../workout/types';
import type { Sample } from './metrics';
import { SPIN_DOWN_IDLE, isActive, spinDownReduce, type SpinDownEvent, type SpinDownState } from './spin-down';

export type SessionState = 'idle' | 'running' | 'paused' | 'finished';
export type RideMode = 'erg' | 'free';
/** What the trainer is told to hold: a power target (ERG) or a gradient (simulation). */
export type ControlMode = 'power' | 'grade';
/** In free riding, whether the rider holds a gradient or a power of their choosing. */
export type FreeTarget = 'grade' | 'power';

/** Typed power targets, watts. Below 25 W a trainer cannot hold anything useful. */
export const MIN_TARGET_WATTS = 25;
export const MAX_TARGET_WATTS = 2000;

export interface Lap { index: number; startTime: number; endTime: number; label: string; }

export interface SessionSnapshot {
  state: SessionState;
  mode: RideMode;
  /** the mode actually in force — a FreeRide block overrides ERG */
  effectiveMode: RideMode;
  workout?: Workout;
  elapsed: number;
  remaining?: number;
  segment?: Segment;
  segmentIndex: number;
  segmentElapsed: number;
  segmentRemaining: number;
  nextSegment?: Segment;
  /** the power target in force: an override, the free watts, or the workout's × bias; 0 when a gradient is held */
  targetPower: number;
  /** what is sent to the trainer. Unlike effectiveMode, free riding at a chosen power is 'power'. */
  controlMode: ControlMode;
  /** watts the rider typed for the current ERG block, in force until the block ends */
  blockOverride?: number;
  freeTarget: FreeTarget;
  /** the free-riding power target, once the rider has chosen Watts */
  freePower?: number;
  targetCadence?: number;
  live: Telemetry;
  /** display average over settings.smoothPowerSeconds (3 s by default) */
  smoothedPower?: number;
  smoothedHeartRate?: number;
  avgPower?: number;
  avgHeartRate?: number;
  lapAvgPower?: number;
  lapAvgHeartRate?: number;
  /** km/h, like Telemetry.speed. On a loaded route this is the virtual speed
   *  from power and the route's gradient, not what the trainer reports. */
  speed?: number;
  distance: number;
  ergBias: number;
  /** the gradient the rider dialled in */
  grade: number;
  /** the gradient actually sent to the trainer (the course's, when following one) */
  effectiveGrade: number;
  followCourse: boolean;
  /** the workout has run out and the ride has carried on as a free ride */
  workoutComplete: boolean;
  /** whether this ride's data has been written out to a .fit file */
  exported: boolean;
  /** false when no connected trainer accepts commands — ERG is then advisory */
  canControlTrainer: boolean;
  coursePosition?: CoursePosition;
  message?: string;
  samples: readonly Sample[];
  laps: readonly Lap[];
}

type SessionEvents = {
  tick: SessionSnapshot;
  state: SessionState;
  workout: Workout | undefined;
  segment: { segment: Segment | undefined; index: number };
  message: string;
  finished: SessionSnapshot;
  calibration: SpinDownState;
};

/** Collapses rapid target changes into at most one trainer write per interval.
 *  Harmless with the mock; essential over BLE, where a flooded control point
 *  makes trainers drop commands. */
class CommandQueue {
  private pending: (() => Promise<void>) | undefined;
  private lastRun = -Infinity;
  private timer: number | undefined;

  constructor(private minIntervalMs: number, private readonly now: () => number) {}

  push(task: () => Promise<void>): void {
    this.pending = task;
    if (this.timer !== undefined) return;
    const wait = this.minIntervalMs - (this.now() - this.lastRun);
    // Straight away when the slot is free: a hidden tab can hold even a
    // zero-delay timer for up to a minute.
    if (wait <= 0) this.run();
    else this.timer = window.setTimeout(this.run, wait);
  }

  /** Sends a waiting command whose interval has passed, for when its timer is
   *  being held back by background throttling. */
  flush(): void {
    if (this.pending && this.now() - this.lastRun >= this.minIntervalMs) this.run();
  }

  private run = (): void => {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const next = this.pending;
    this.pending = undefined;
    this.lastRun = this.now();
    next?.().catch((err) => console.warn('trainer command failed', err));
  };

  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }
}

const SAMPLE_INTERVAL = 1; // second
/** Longest slice of ride time simulated at once; `stepSpeed` needs short steps. */
const MAX_STEP_SECONDS = 0.5;
/** A longer gap with no advance at all is a suspended machine, not a hidden
 *  tab (Chrome throttles hidden timers to about one a minute), and is not
 *  added to the ride. */
export const MAX_CATCH_UP_SECONDS = 300;
/** Advance rate when frames stop; hidden tabs stretch it to a second or more. */
const BACKGROUND_TICK_MS = 250;
const BUFFER_SECONDS = 31;
const WORKOUT_DONE_MESSAGE = 'Workout complete — free riding from here';
const WORKOUT_DONE_SECONDS = 12;
/** Most spin-downs take 20–40 s; past this, the trainer is not going to answer. */
export const SPIN_DOWN_TIMEOUT_MS = 90_000;
const CALIBRATING_MESSAGE = 'Calibration in progress — finish or cancel it first';
const CALIBRATING_SECONDS = 5;

interface RunningTotals { power: number; powerCount: number; hr: number; hrCount: number; }

const emptyTotals = (): RunningTotals => ({ power: 0, powerCount: 0, hr: 0, hrCount: 0 });

const validWatts = (watts: number): boolean =>
  Number.isFinite(watts) && watts >= MIN_TARGET_WATTS && watts <= MAX_TARGET_WATTS;

export class Session extends Emitter<SessionEvents> {
  private state: SessionState = 'idle';
  private mode: RideMode = 'erg';
  private workout: Workout | undefined;
  private elapsed = 0;
  private distance = 0;
  /** m/s along the loaded route; undefined until the next frame seeds it */
  private virtualSpeed: number | undefined;
  private ergBias = 1;
  private grade = 0;
  private follow = false;
  /** a typed target for one ERG block, identified by its segment index */
  private override: { segmentIndex: number; watts: number } | undefined;
  private freeTarget: FreeTarget = 'grade';
  private freePower: number | undefined;
  private samples: Sample[] = [];
  private laps: Lap[] = [];
  private lapStart = 0;
  private lapLabel = 'Lap 1';
  private live: Telemetry = {};
  private powerBuffer: { t: number; value: number }[] = [];
  private hrBuffer: { t: number; value: number }[] = [];
  private sessionTotals = emptyTotals();
  private lapTotals = emptyTotals();
  private lastFrame: number | undefined;
  private advancing = false;
  private nextSampleAt = SAMPLE_INTERVAL;
  private segmentIndex = -1;
  private completedLoops = 0;
  private pastWorkoutEnd = false;
  private hadControl = false;
  private lastTargetSent: number | undefined;
  private lastGradeSent: number | undefined;
  private messageUntil = 0;
  private message: string | undefined;
  private firedEvents = new Set<number>();
  private commands: CommandQueue;
  private raf: number | undefined;
  private timer: number | undefined;
  private readonly unsubscribe: (() => void)[] = [];
  private spinDown: SpinDownState = SPIN_DOWN_IDLE;
  /** bumped per calibration, so a slow answer to an abandoned one is ignored */
  private spinDownRun = 0;
  private spinDownWatch: (() => void)[] = [];
  startedAt: Date | undefined;
  /** set once the rider has downloaded this ride, so it can be discarded safely */
  exported = false;

  constructor(
    private readonly devices: DeviceHub,
    private readonly spinDownTimeoutMs = SPIN_DOWN_TIMEOUT_MS,
    /** the session's clock in ms; tests pass a fake one to skip time without waiting */
    private readonly now: () => number = () => performance.now(),
  ) {
    super();
    this.commands = new CommandQueue(500, this.now);
    // Sensor notifications keep arriving in a hidden tab, where frames stop
    // and timers are throttled, so each one also moves the ride along.
    this.unsubscribe.push(this.devices.on('telemetry', (t) => { this.live = t; this.advance(); }));
    // A new or removed route restarts the virtual speed from what the sensors say.
    courseStore.on('course', (course) => {
      this.virtualSpeed = undefined;
      // Riding a route means riding its hills, so a new route is followed
      // until the rider says otherwise.
      this.follow = course !== undefined;
      this.lastGradeSent = undefined;
      if (this.state === 'running') this.pushTrainerCommand(true);
    });
    this.loop();
    this.timer = window.setInterval(() => this.advance(), BACKGROUND_TICK_MS);
    // Catch up the moment the rider comes back, not on the next sensor packet.
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  // ---- queries -------------------------------------------------------------

  get snapshot(): SessionSnapshot {
    // Past the last block the workout is over, but the ride is not: it carries
    // on as a free ride until the rider finishes it.
    const complete = this.workout !== undefined && this.elapsed >= this.workout.duration;
    const segment = this.workout && !complete ? segmentAt(this.workout, this.elapsed) : undefined;
    const next = segment && this.workout ? this.workout.segments[segment.index + 1] : undefined;
    const effectiveMode: RideMode = this.mode === 'free' || complete ? 'free' : (segment?.mode ?? 'free');
    const coursePosition = courseStore.current?.at(this.distance);
    const courseGrade = this.follow ? coursePosition?.gradient : undefined;

    return {
      state: this.state,
      mode: this.mode,
      effectiveMode,
      workout: this.workout,
      elapsed: this.elapsed,
      remaining: this.workout && !complete ? Math.max(0, this.workout.duration - this.elapsed) : undefined,
      segment,
      segmentIndex: segment?.index ?? -1,
      segmentElapsed: segment ? this.elapsed - segment.start : 0,
      segmentRemaining: segment ? Math.max(0, segment.start + segment.duration - this.elapsed) : 0,
      nextSegment: next,
      targetPower: this.targetPower(),
      controlMode: this.controlMode(effectiveMode),
      blockOverride: this.activeOverride()?.watts,
      freeTarget: this.freeTarget,
      freePower: this.freePower,
      targetCadence: segment?.cadence,
      live: this.live,
      smoothedPower: this.smoothed(this.powerBuffer, this.live.power),
      smoothedHeartRate: this.smoothed(this.hrBuffer, this.live.heartRate),
      avgPower: this.sessionTotals.powerCount ? this.sessionTotals.power / this.sessionTotals.powerCount : undefined,
      avgHeartRate: this.sessionTotals.hrCount ? this.sessionTotals.hr / this.sessionTotals.hrCount : undefined,
      lapAvgPower: this.lapTotals.powerCount ? this.lapTotals.power / this.lapTotals.powerCount : undefined,
      lapAvgHeartRate: this.lapTotals.hrCount ? this.lapTotals.hr / this.lapTotals.hrCount : undefined,
      speed: this.currentSpeed(),
      distance: this.distance,
      ergBias: this.ergBias,
      grade: this.grade,
      effectiveGrade: courseGrade ?? this.grade,
      followCourse: this.follow,
      workoutComplete: complete,
      exported: this.exported,
      canControlTrainer: this.devices.control !== undefined,
      coursePosition,
      message: this.message,
      samples: this.samples,
      laps: this.laps,
    };
  }

  /** The ERG segment in force now, if any: a workout running, not complete,
   *  not switched to Free, and the current block not a FreeRide. */
  private ergSegment(): Segment | undefined {
    if (!this.workout || this.mode === 'free') return undefined;
    if (this.elapsed >= this.workout.duration) return undefined;
    const segment = segmentAt(this.workout, this.elapsed);
    return segment && segment.mode !== 'free' ? segment : undefined;
  }

  /** The block override, only while its own block is the ERG block in force. */
  private activeOverride(): { segmentIndex: number; watts: number } | undefined {
    const segment = this.ergSegment();
    return segment && this.override?.segmentIndex === segment.index ? this.override : undefined;
  }

  private controlMode(effectiveMode: RideMode): ControlMode {
    return effectiveMode === 'erg' || this.freeTarget === 'power' ? 'power' : 'grade';
  }

  targetPower(): number {
    const segment = this.ergSegment();
    if (!segment) {
      // Free riding: a gradient, unless the rider chose to hold a power.
      return this.freeTarget === 'power' ? this.freePower ?? 0 : 0;
    }
    const override = this.activeOverride();
    if (override) return override.watts;
    const ratio = targetRatioAt(segment, this.elapsed);
    if (ratio === undefined) return 0;
    const ftp = this.workout!.ftpOverride ?? settings.current.ftp;
    return Math.round(ratio * ftp * this.ergBias);
  }

  /** km/h: the virtual speed on a route, the sensors' speed otherwise. */
  private currentSpeed(): number | undefined {
    if (courseStore.current && this.virtualSpeed !== undefined) return this.virtualSpeed * 3.6;
    return this.live.speed;
  }

  /**
   * Speed over the next dt seconds, in km/h. On a route it comes from power and
   * the gradient under the wheels, in every mode, so climbs are ridden at
   * climbing speed even when ERG holds the brake at a flat-road target. Nothing
   * here is sent to the trainer.
   */
  private advanceSpeed(dt: number): number {
    const course = courseStore.current;
    if (!course) {
      this.virtualSpeed = undefined;
      return this.live.speed ?? 0;
    }
    const { riderWeight, bikeWeight } = settings.current;
    this.virtualSpeed = stepSpeed(
      this.virtualSpeed ?? (this.live.speed ?? 0) / 3.6,
      this.live.power ?? 0,
      dt,
      { ...DEFAULT_BIKE, mass: riderWeight + bikeWeight, grade: course.at(this.distance).gradient },
    );
    return this.virtualSpeed * 3.6;
  }

  private smoothed(buffer: { t: number; value: number }[], latest: number | undefined): number | undefined {
    if (latest === undefined) return undefined;
    const window = settings.current.smoothPowerSeconds;
    if (window <= 0 || buffer.length === 0) return Math.round(latest);
    const cutoff = this.now() - window * 1000;
    let sum = 0;
    let count = 0;
    for (let i = buffer.length - 1; i >= 0 && buffer[i].t >= cutoff; i--) {
      sum += buffer[i].value;
      count++;
    }
    return count ? Math.round(sum / count) : Math.round(latest);
  }

  // ---- calibration ---------------------------------------------------------

  get calibration(): SpinDownState { return this.spinDown; }

  /** Whether the trainer can be calibrated now, or why not. */
  get canCalibrate(): boolean {
    return (this.state === 'idle' || this.state === 'finished') && !isActive(this.spinDown);
  }

  /**
   * Run a spin-down on the active trainer. Only between rides: the session
   * writes nothing to the trainer while idle or finished, and refuses to start
   * a ride until the spin-down ends, so the two never share the brake.
   * Resolves once the trainer has answered the request; the result arrives
   * later on the 'calibration' event.
   */
  async calibrate(): Promise<void> {
    if (this.state === 'running' || this.state === 'paused') throw new Error('Finish the ride first');
    if (isActive(this.spinDown)) throw new Error('Calibration is already running');
    const trainer = this.devices.trainer;
    const spinDown = this.devices.control?.spinDown;
    if (!trainer || !spinDown) throw new Error('This trainer cannot be calibrated');

    const run = ++this.spinDownRun;
    this.applySpinDown({ type: 'requested' });
    const timer = window.setTimeout(() => this.applySpinDown({ type: 'timeout' }), this.spinDownTimeoutMs);
    this.spinDownWatch = [
      () => clearTimeout(timer),
      // However it ended — a timeout included — the next target needs the
      // trainer put back under control first.
      () => spinDown.end?.(),
      spinDown.onSignal((signal) => this.applySpinDown({ type: 'signal', signal })),
      trainer.onStatus((status) => {
        if (status !== 'connected') this.applySpinDown({ type: 'disconnected' });
      }),
    ];

    try {
      const targets = await spinDown.start();
      if (run === this.spinDownRun) this.applySpinDown({ type: 'accepted', targets });
    } catch (err) {
      if (run === this.spinDownRun) this.applySpinDown({ type: 'refused', reason: (err as Error).message });
    }
  }

  cancelCalibration(): void {
    if (!isActive(this.spinDown)) return;
    const spinDown = this.devices.control?.spinDown;
    this.applySpinDown({ type: 'cancelled' });
    // The row is back to normal whether or not the trainer hears this.
    spinDown?.cancel().catch(() => {});
  }

  /** Clear a finished calibration's result from the trainer row. */
  dismissCalibration(): void {
    this.applySpinDown({ type: 'dismissed' });
  }

  private applySpinDown(event: SpinDownEvent): void {
    const next = spinDownReduce(this.spinDown, event);
    if (next === this.spinDown) return;
    const wasActive = isActive(this.spinDown);
    this.spinDown = next;
    if (wasActive && !isActive(next)) {
      this.spinDownWatch.forEach((stop) => stop());
      this.spinDownWatch = [];
    }
    this.emit('calibration', next);
  }

  // ---- workout -------------------------------------------------------------

  loadWorkout(workout: Workout | undefined): void {
    if (this.state === 'running') this.pause();
    this.workout = workout;
    this.override = undefined;
    this.elapsed = 0;
    this.segmentIndex = -1;
    this.pastWorkoutEnd = false;
    this.firedEvents.clear();
    this.nextSampleAt = SAMPLE_INTERVAL;
    if (this.state !== 'idle') this.resetRide();
    this.emit('workout', workout);
    this.emit('tick', this.snapshot);
  }

  // ---- controls ------------------------------------------------------------

  start(): void {
    if (this.state === 'running') return;
    // A target sent now would land in the middle of the trainer's spin-down.
    if (isActive(this.spinDown)) {
      this.message = CALIBRATING_MESSAGE;
      this.messageUntil = this.now() + CALIBRATING_SECONDS * 1000;
      this.emit('message', CALIBRATING_MESSAGE);
      return;
    }
    if (this.state === 'finished' || this.state === 'idle') this.resetRide();
    this.startedAt ??= new Date();
    this.setState('running');
  }

  pause(): void {
    if (this.state !== 'running') return;
    this.setState('paused');
  }

  toggle(): void {
    if (this.state === 'running') this.pause(); else this.start();
  }

  finish(): SessionSnapshot {
    this.commands.clear();
    const control = this.devices.control;
    control?.setTargetPower(0).catch(() => {});
    control?.stop?.().catch(() => {});
    this.closeLap('end');
    this.setState('finished');
    const snap = this.snapshot;
    this.emit('finished', snap);
    return snap;
  }

  reset(): void {
    this.resetRide();
    this.setState('idle');
  }

  private resetRide(): void {
    this.override = undefined;
    this.elapsed = 0;
    this.distance = 0;
    this.virtualSpeed = undefined;
    this.samples = [];
    this.laps = [];
    this.lapStart = 0;
    this.lapLabel = 'Lap 1';
    this.powerBuffer = [];
    this.hrBuffer = [];
    this.sessionTotals = emptyTotals();
    this.lapTotals = emptyTotals();
    this.nextSampleAt = SAMPLE_INTERVAL;
    this.segmentIndex = -1;
    this.completedLoops = 0;
    this.pastWorkoutEnd = false;
    this.exported = false;
    this.lastTargetSent = undefined;
    this.lastGradeSent = undefined;
    this.firedEvents.clear();
    this.startedAt = undefined;
    this.message = undefined;
  }

  /** Whether a trainer is connected that this app can actually command. */
  get canControlTrainer(): boolean {
    return this.devices.control !== undefined;
  }

  setMode(mode: RideMode): void {
    this.mode = mode;
    this.lastTargetSent = undefined;
    this.lastGradeSent = undefined;
    this.pushTrainerCommand(true);
    this.emit('tick', this.snapshot);
  }

  setErgBias(bias: number): void {
    // An override is exact watts; bias waits, unchanged, for the block to end.
    if (this.activeOverride()) return;
    this.ergBias = clamp(bias, 0.5, 1.5);
    this.pushTrainerCommand(true);
    this.emit('tick', this.snapshot);
  }

  nudgeBias(delta: number): void { this.setErgBias(this.ergBias + delta); }

  setGrade(grade: number): void {
    this.grade = clamp(grade, -10, 20);
    this.pushTrainerCommand(true);
    this.emit('tick', this.snapshot);
  }

  /**
   * Hold `watts` for the rest of the current ERG block instead of the
   * workout's target × bias; undefined clears it. Refused (false) outside an
   * ERG block or outside MIN_TARGET_WATTS..MAX_TARGET_WATTS.
   */
  setBlockOverride(watts: number | undefined): boolean {
    if (watts === undefined) {
      if (!this.override) return true;
      this.override = undefined;
    } else {
      const segment = this.ergSegment();
      if (!segment || !validWatts(watts)) return false;
      this.override = { segmentIndex: segment.index, watts: Math.round(watts) };
    }
    this.lastTargetSent = undefined;
    this.pushTrainerCommand(true);
    this.emit('tick', this.snapshot);
    return true;
  }

  /** Whether free riding holds a gradient or a power. Choosing power for the
   *  first time starts it at 60 % of FTP, to the nearest 5 W. */
  setFreeTarget(target: FreeTarget): void {
    this.freeTarget = target;
    if (target === 'power') this.freePower ??= Math.round((0.6 * settings.current.ftp) / 5) * 5;
    this.lastTargetSent = undefined;
    this.lastGradeSent = undefined;
    this.pushTrainerCommand(true);
    this.emit('tick', this.snapshot);
  }

  /** The free-riding power target. Refused (false) outside MIN..MAX_TARGET_WATTS. */
  setFreePower(watts: number): boolean {
    if (!validWatts(watts)) return false;
    this.freePower = Math.round(watts);
    this.lastTargetSent = undefined;
    this.pushTrainerCommand(true);
    this.emit('tick', this.snapshot);
    return true;
  }

  /** In free mode, take the gradient from the loaded route instead of the slider. */
  setFollowCourse(follow: boolean): void {
    this.follow = follow;
    this.lastGradeSent = undefined;
    this.pushTrainerCommand(true);
    this.emit('tick', this.snapshot);
  }

  /** Moves the workout clock forward by `seconds`, never past the workout's end.
   *  The clock only ever moves forward on request: a backward seek, or any seek
   *  once the workout has run out, leaves it where it is. */
  seek(seconds: number): void {
    if (!this.workout || seconds <= 0 || this.elapsed >= this.workout.duration) return;
    this.jumpTo(Math.min(this.elapsed + seconds, this.workout.duration));
  }

  /** Moves to the start of the next block, or to the workout's end from the last. */
  skipToNextBlock(): void {
    // past the end segmentAt still answers with the last block, whose "next" is
    // the end itself, which would be a step back
    if (!this.workout || this.elapsed >= this.workout.duration) return;
    const current = segmentAt(this.workout, this.elapsed);
    if (!current) return;
    const next = this.workout.segments[current.index + 1];
    this.jumpTo(next ? next.start : this.workout.duration);
  }

  private jumpTo(seconds: number): void {
    this.elapsed = seconds;
    this.nextSampleAt = Math.ceil(seconds / SAMPLE_INTERVAL) * SAMPLE_INTERVAL;
    this.pushTrainerCommand(true);
    this.emit('tick', this.snapshot);
  }

  /** Called once the rider has downloaded the ride, so discarding it is safe. */
  markExported(): void {
    this.exported = true;
    this.emit('tick', this.snapshot);
  }

  markLap(label?: string): void {
    this.closeLap(label ?? `Lap ${this.laps.length + 1}`);
  }

  private closeLap(label: string): void {
    if (this.elapsed - this.lapStart < 1) return;
    this.laps.push({ index: this.laps.length, startTime: this.lapStart, endTime: this.elapsed, label: this.lapLabel });
    this.lapStart = this.elapsed;
    this.lapLabel = label === 'end' ? `Lap ${this.laps.length + 1}` : label;
    this.lapTotals = emptyTotals();
  }

  // ---- loop ----------------------------------------------------------------

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    this.advance();
  };

  /**
   * Brings the ride up to the clock. Hidden tabs get no animation frames and
   * throttled timers, so the gap since the last call can be many seconds; it
   * is walked in short steps so speed integration, samples, laps and targets
   * land where they would have had the tab stayed visible. A gap too long to
   * be throttling (the machine slept) is not credited at all.
   */
  advance(now = this.now()): void {
    if (this.advancing) return;
    this.advancing = true;
    try {
      this.fillBuffer(this.powerBuffer, this.live.power, now);
      this.fillBuffer(this.hrBuffer, this.live.heartRate, now);

      // A trainer that connects — or comes back after a dropout — mid-ride needs
      // to be told the current target, or it keeps whatever its brake was on.
      const controlAvailable = this.devices.control !== undefined;
      if (controlAvailable !== this.hadControl) {
        this.hadControl = controlAvailable;
        if (controlAvailable && this.state === 'running') this.pushTrainerCommand(true);
      }

      const from = this.lastFrame ?? now;
      const gap = (now - from) / 1000;
      if (gap > 0 && gap <= MAX_CATCH_UP_SECONDS) {
        const steps = Math.ceil(gap / MAX_STEP_SECONDS);
        for (let i = 0; i < steps; i++) this.step(gap / steps);
      }
      this.lastFrame = now;

      this.commands.flush();
      if (this.message && now > this.messageUntil) this.message = undefined;
      this.emit('tick', this.snapshot);
    } finally {
      this.advancing = false;
    }
  }

  /** One short slice of ride time. */
  private step(dt: number): void {
    if (this.state === 'running') {
      this.elapsed += dt;
      this.distance += (this.advanceSpeed(dt) / 3.6) * dt;

      this.detectWorkoutEnd();
      this.detectSegmentChange();
      this.detectCourseLoop();
      this.fireTextEvents();
      this.recordSamples();
      this.pushTrainerCommand(false);
    }
  }

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') this.advance();
  };

  dispose(): void {
    if (this.raf !== undefined) cancelAnimationFrame(this.raf);
    if (this.timer !== undefined) clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const off of this.unsubscribe.splice(0)) off();
    this.commands.clear();
  }

  private fillBuffer(buffer: { t: number; value: number }[], value: number | undefined, now: number): void {
    if (value === undefined) return;
    buffer.push({ t: now, value });
    const cutoff = now - BUFFER_SECONDS * 1000;
    while (buffer.length && buffer[0].t < cutoff) buffer.shift();
  }

  /**
   * Crossing the end of the workout, in either direction. The ride keeps going
   * — ERG hands over to free riding — so this only switches the trainer over
   * and marks the boundary with a lap.
   */
  private detectWorkoutEnd(): void {
    const complete = this.workout !== undefined && this.elapsed >= this.workout.duration;
    if (complete === this.pastWorkoutEnd) return;
    this.pastWorkoutEnd = complete;
    this.lastTargetSent = undefined;
    this.lastGradeSent = undefined;
    if (complete) {
      this.closeLap('Free ride');
      this.message = WORKOUT_DONE_MESSAGE;
      this.messageUntil = this.now() + WORKOUT_DONE_SECONDS * 1000;
      this.emit('message', WORKOUT_DONE_MESSAGE);
    }
    this.pushTrainerCommand(true);
  }

  private detectSegmentChange(): void {
    if (!this.workout || this.pastWorkoutEnd) return;
    const segment = segmentAt(this.workout, this.elapsed);
    const index = segment?.index ?? -1;
    if (index === this.segmentIndex) return;
    if (this.segmentIndex >= 0) this.closeLap(segment?.label ?? 'Lap');
    this.segmentIndex = index;
    // An override belongs to the block it was typed in.
    if (this.override && this.override.segmentIndex !== index) this.override = undefined;
    this.lastTargetSent = undefined;
    this.emit('segment', { segment, index });
  }

  /** A completed lap of the route is a lap, the same as a workout block change. */
  private detectCourseLoop(): void {
    const course = courseStore.current;
    if (!course || course.totalDistance <= 0) return;
    const loops = Math.floor(this.distance / course.totalDistance);
    if (loops <= this.completedLoops) return;
    this.completedLoops = loops;
    this.closeLap(`Loop ${loops + 1}`);
  }

  private fireTextEvents(): void {
    if (!this.workout) return;
    for (const event of this.workout.textEvents) {
      if (this.firedEvents.has(event.time) || this.elapsed < event.time) continue;
      if (this.elapsed > event.time + event.duration) { this.firedEvents.add(event.time); continue; }
      this.firedEvents.add(event.time);
      this.message = event.message;
      this.messageUntil = this.now() + event.duration * 1000;
      this.emit('message', event.message);
    }
  }

  private recordSamples(): void {
    while (this.elapsed >= this.nextSampleAt) {
      const power = Math.round(this.live.power ?? 0);
      const heartRate = this.live.heartRate;
      // When a route is loaded, every second is stamped with where on it the
      // rider has got to, so the exported ride carries a real GPS track.
      const position = courseStore.current?.at(this.distance);
      this.samples.push({
        t: this.nextSampleAt,
        power,
        targetPower: this.targetPower(),
        heartRate,
        cadence: this.live.cadence,
        speed: this.currentSpeed(),
        distance: this.distance,
        lat: position?.lat,
        lon: position?.lon,
        altitude: position?.ele,
      });
      for (const totals of [this.sessionTotals, this.lapTotals]) {
        totals.power += power;
        totals.powerCount++;
        if (heartRate !== undefined && heartRate > 0) { totals.hr += heartRate; totals.hrCount++; }
      }
      this.nextSampleAt += SAMPLE_INTERVAL;
    }
  }

  /** Send ERG target or simulated grade when it has actually moved. */
  private pushTrainerCommand(force: boolean): void {
    const control = this.devices.control;
    if (!control) return;
    const snap = this.snapshot;

    if (snap.controlMode === 'power') {
      const target = snap.targetPower;
      if (force || this.lastTargetSent === undefined || Math.abs(target - this.lastTargetSent) >= 1) {
        this.lastTargetSent = target;
        this.lastGradeSent = undefined;
        this.commands.push(() => control.setTargetPower(target));
      }
      return;
    }

    const grade = snap.effectiveGrade;
    if (force || this.lastGradeSent === undefined || Math.abs(grade - this.lastGradeSent) >= 0.1) {
      this.lastGradeSent = grade;
      this.lastTargetSent = undefined;
      this.commands.push(() => control.setSimulation({
        grade,
        crr: 0.004,
        // FTMS wind resistance coefficient for a road bike at ~0.32 m^2 CdA
        cw: 0.51,
        windSpeed: 0,
      }));
    }
  }

  private setState(state: SessionState): void {
    if (this.state === state) return;
    this.state = state;
    // Time before this moment was not ridden, however stale the last advance.
    if (state === 'running') this.lastFrame = this.now();
    if (state === 'running') this.pushTrainerCommand(true);
    if (state === 'paused') {
      const control = this.devices.control;
      control?.setTargetPower(0).catch(() => {});
      this.lastTargetSent = undefined;
    }
    this.emit('state', state);
    this.emit('tick', this.snapshot);
  }
}

export const session = new Session(hub);
