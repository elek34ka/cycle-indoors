export interface BikeModel {
  /** rider + bike, kg */
  mass: number;
  /** road gradient, percent */
  grade: number;
  /** coefficient of rolling resistance */
  crr: number;
  /** drag area, m^2 */
  cda: number;
  /** air density, kg/m^3 */
  rho: number;
  /** drivetrain efficiency */
  efficiency: number;
}

export const DEFAULT_BIKE: Omit<BikeModel, 'mass' | 'grade'> = {
  crr: 0.004,
  cda: 0.32,
  rho: 1.225,
  efficiency: 0.97,
};

const G = 9.8067;

/** Power needed to hold a given speed (m/s). */
export function powerForSpeed(v: number, m: BikeModel): number {
  const slope = m.grade / 100;
  const rolling = m.crr * m.mass * G * Math.cos(Math.atan(slope));
  const gravity = m.mass * G * Math.sin(Math.atan(slope));
  const drag = 0.5 * m.rho * m.cda * v * v;
  return (v * (rolling + gravity + drag)) / m.efficiency;
}

/** Invert the power equation by bisection — stable even on steep descents. */
export function speedForPower(watts: number, m: BikeModel): number {
  if (watts <= 0 && m.grade >= 0) return 0;
  let lo = 0;
  let hi = 30; // 108 km/h is plenty
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (powerForSpeed(mid, m) < watts) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Longest step stepSpeed integrates in one go; frames can be up to 0.5 s. */
const MAX_SUBSTEP = 0.1;

/**
 * Advance a rider's speed (m/s) by dt seconds at a given power, with inertia.
 * Integrates kinetic energy rather than force, so it is well behaved from a
 * standstill and gravity on a descent adds speed even at 0 W.
 */
export function stepSpeed(v: number, watts: number, dt: number, m: BikeModel): number {
  const slope = m.grade / 100;
  const rolling = m.crr * m.mass * G * Math.cos(Math.atan(slope));
  const gravity = m.mass * G * Math.sin(Math.atan(slope));
  const drive = Math.max(0, watts) * m.efficiency;
  let speed = Math.max(0, v);
  let remaining = Math.max(0, dt);
  while (remaining > 0) {
    const h = Math.min(MAX_SUBSTEP, remaining);
    remaining -= h;
    if (speed === 0 && drive === 0) {
      // Stopped and not pedalling: only a descent steeper than rolling
      // resistance can get the bike moving.
      speed = Math.max(0, (-gravity - rolling) / m.mass) * h;
      continue;
    }
    const drag = 0.5 * m.rho * m.cda * speed * speed;
    const energy = 0.5 * m.mass * speed * speed + (drive - speed * (rolling + gravity + drag)) * h;
    speed = energy > 0 ? Math.sqrt((2 * energy) / m.mass) : 0;
  }
  return speed;
}

export function kph(metresPerSecond: number): number {
  return metresPerSecond * 3.6;
}
