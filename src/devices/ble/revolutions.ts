import type { RevolutionData } from './parsers';

/** Revolution counters and event times roll over; deltas must be taken modulo
 *  the field width or the first wrap produces an absurd cadence. */
const U16 = 0x10000;
const U32 = 0x100000000;

const mod = (value: number, size: number) => ((value % size) + size) % size;

/** When the event time stops advancing, the rider has stopped. */
const COAST_TIMEOUT_MS = 2500;
const MAX_CADENCE = 250;
const MAX_SPEED_KPH = 150;

/** Crank revolutions to rpm. Event time is 1/1024 s in both CPS and CSCS. */
export class CrankCadenceTracker {
  private last: RevolutionData | undefined;
  private lastValue: number | undefined;
  private lastEventAt = 0;

  reset(): void {
    this.last = undefined;
    this.lastValue = undefined;
    this.lastEventAt = 0;
  }

  update(data: RevolutionData, nowMs: number): number | undefined {
    const previous = this.last;
    this.last = data;
    if (!previous) {
      this.lastEventAt = nowMs;
      return undefined;
    }

    const dTicks = mod(data.time - previous.time, U16);
    if (dTicks === 0) {
      // No new crank event. Hold the last value briefly, then call it a stop.
      if (nowMs - this.lastEventAt > COAST_TIMEOUT_MS) {
        this.lastValue = 0;
        return 0;
      }
      return this.lastValue;
    }

    const dRevs = mod(data.revolutions - previous.revolutions, U16);
    this.lastEventAt = nowMs;
    const rpm = (dRevs / (dTicks / 1024)) * 60;
    if (!Number.isFinite(rpm) || rpm > MAX_CADENCE) return this.lastValue;
    this.lastValue = rpm;
    return rpm;
  }
}

export interface WheelUpdate {
  /** km/h, undefined until two events have been seen */
  speed?: number;
  /** metres covered since the previous event */
  distanceDelta: number;
  /** metres since this tracker was reset */
  totalDistance: number;
}

/** Wheel revolutions to speed and distance. CPS ticks at 1/2048 s, CSCS at 1/1024 s. */
export class WheelSpeedTracker {
  private last: RevolutionData | undefined;
  private lastValue: number | undefined;
  private lastEventAt = 0;
  private distance = 0;

  constructor(private readonly ticksPerSecond: number) {}

  reset(): void {
    this.last = undefined;
    this.lastValue = undefined;
    this.lastEventAt = 0;
    this.distance = 0;
  }

  update(data: RevolutionData, circumferenceMm: number, nowMs: number): WheelUpdate {
    const previous = this.last;
    this.last = data;
    if (!previous) {
      this.lastEventAt = nowMs;
      return { distanceDelta: 0, totalDistance: this.distance };
    }

    const dTicks = mod(data.time - previous.time, U16);
    const dRevs = mod(data.revolutions - previous.revolutions, U32);
    const metres = (dRevs * circumferenceMm) / 1000;
    this.distance += metres;

    if (dTicks === 0) {
      if (nowMs - this.lastEventAt > COAST_TIMEOUT_MS) {
        this.lastValue = 0;
        return { speed: 0, distanceDelta: metres, totalDistance: this.distance };
      }
      return { speed: this.lastValue, distanceDelta: metres, totalDistance: this.distance };
    }

    this.lastEventAt = nowMs;
    const seconds = dTicks / this.ticksPerSecond;
    const kph = (metres / seconds) * 3.6;
    if (Number.isFinite(kph) && kph <= MAX_SPEED_KPH) this.lastValue = kph;
    return { speed: this.lastValue, distanceDelta: metres, totalDistance: this.distance };
  }
}
