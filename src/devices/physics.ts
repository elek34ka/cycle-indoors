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

export function kph(metresPerSecond: number): number {
  return metresPerSecond * 3.6;
}
