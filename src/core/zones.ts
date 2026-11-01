export interface Zone { id: number; key: string; label: string; max: number; color: string; }

type ZoneLook = Omit<Zone, 'max'>;

const POWER_LOOK: readonly ZoneLook[] = [
  { id: 1, key: 'z1', label: 'Active recovery', color: '#7a8694' },
  { id: 2, key: 'z2', label: 'Endurance',       color: '#3f8fd8' },
  { id: 3, key: 'z3', label: 'Tempo',           color: '#3fc07a' },
  { id: 4, key: 'z4', label: 'Threshold',       color: '#f0c33c' },
  { id: 5, key: 'z5', label: 'VO2 max',         color: '#f08a35' },
  { id: 6, key: 'z6', label: 'Anaerobic',       color: '#e4563c' },
  { id: 7, key: 'z7', label: 'Neuromuscular',   color: '#c2437f' },
];

const HR_LOOK: readonly ZoneLook[] = [
  { id: 1, key: 'z1', label: 'Recovery',  color: '#7a8694' },
  { id: 2, key: 'z2', label: 'Endurance', color: '#3f8fd8' },
  { id: 3, key: 'z3', label: 'Tempo',     color: '#3fc07a' },
  { id: 4, key: 'z4', label: 'Threshold', color: '#f08a35' },
  { id: 5, key: 'z5', label: 'Maximum',   color: '#e4563c' },
];

/** Coggan's power zones: upper bounds of Z1–Z6 as a fraction of FTP (Z7 is unbounded). */
export const DEFAULT_POWER_BOUNDS: readonly number[] = [0.55, 0.75, 0.90, 1.05, 1.20, 1.50];
/** Heart-rate zones: upper bounds of Z1–Z4 as a fraction of max HR (Z5 is unbounded). */
export const DEFAULT_HR_BOUNDS: readonly number[] = [0.60, 0.70, 0.80, 0.90];

export type ZoneKind = 'power' | 'hr';

/** The range a bound may take, as a fraction of FTP or max HR. */
export const BOUND_LIMITS: Record<ZoneKind, { min: number; max: number }> = {
  power: { min: 0.10, max: 3.00 },
  hr: { min: 0.30, max: 1.00 },
};

const LOOK: Record<ZoneKind, readonly ZoneLook[]> = { power: POWER_LOOK, hr: HR_LOOK };
export const DEFAULT_BOUNDS: Record<ZoneKind, readonly number[]> = { power: DEFAULT_POWER_BOUNDS, hr: DEFAULT_HR_BOUNDS };

function build(look: readonly ZoneLook[], bounds: readonly number[]): Zone[] {
  return look.map((z, i) => ({ ...z, max: i < bounds.length ? bounds[i] : Infinity }));
}

/** 7 power zones, `max` as a fraction of FTP; the formula's without `bounds`. */
export function powerZones(bounds: readonly number[] | null = null): Zone[] {
  return build(POWER_LOOK, bounds ?? DEFAULT_POWER_BOUNDS);
}

/** 5 heart-rate zones, `max` as a fraction of max HR; the formula's without `bounds`. */
export function hrZones(bounds: readonly number[] | null = null): Zone[] {
  return build(HR_LOOK, bounds ?? DEFAULT_HR_BOUNDS);
}

/** The standard zones, whatever the rider set: the Library and the catalog use these. */
export const POWER_ZONES: Zone[] = powerZones();
export const HR_ZONES: Zone[] = hrZones();

const pct = (fraction: number) => `${Math.round(fraction * 1000) / 10}%`;

/**
 * Why `bounds` cannot be a zone set's upper bounds, or undefined when they
 * can: one per zone below the top, each finite, inside the kind's limits, and
 * each above the one before.
 */
export function boundsProblem(kind: ZoneKind, bounds: unknown): string | undefined {
  const expected = LOOK[kind].length - 1;
  const name = kind === 'power' ? 'Power zone' : 'Heart-rate zone';
  if (!Array.isArray(bounds) || bounds.length !== expected) return `${name} bounds must be ${expected} values`;
  const { min, max } = BOUND_LIMITS[kind];
  const of = kind === 'power' ? 'FTP' : 'max HR';
  for (let i = 0; i < bounds.length; i++) {
    const b = bounds[i];
    if (typeof b !== 'number' || !Number.isFinite(b)) return `Z${i + 1} must end at a number`;
    if (b < min || b > max) return `Z${i + 1} must end between ${pct(min)} and ${pct(max)} of ${of}`;
    if (i > 0 && b <= bounds[i - 1]) return `Z${i + 1} must end above Z${i}, at more than ${pct(bounds[i - 1])}`;
  }
  return undefined;
}

/** The zones a rider measures their own riding by. */
export interface RiderZones { power: Zone[]; hr: Zone[]; }

/** The rider's zones from their settings; `null` bounds mean the formula. */
export function riderZones(s: { powerZoneBounds: readonly number[] | null; hrZoneBounds: readonly number[] | null }): RiderZones {
  return { power: powerZones(s.powerZoneBounds), hr: hrZones(s.hrZoneBounds) };
}

/** The zone a fraction of FTP falls in; a bound belongs to the zone below it. */
export function zoneForRatio(ratio: number, zones: readonly Zone[] = POWER_ZONES): Zone {
  for (const z of zones) if (ratio <= z.max) return z;
  return zones[zones.length - 1];
}

export function zoneForPower(watts: number, ftp: number, zones: readonly Zone[] = POWER_ZONES): Zone {
  return zoneForRatio(ftp > 0 ? watts / ftp : 0, zones);
}

/** The zone a heart rate falls in; a bound belongs to the zone below it, as for power. */
export function zoneForHr(bpm: number, hrMax: number, zones: readonly Zone[] = HR_ZONES): Zone {
  const r = hrMax > 0 ? bpm / hrMax : 0;
  for (const z of zones) if (r <= z.max) return z;
  return zones[zones.length - 1];
}

export function hrZoneColor(bpm: number, hrMax: number, zones: readonly Zone[] = HR_ZONES): string {
  return zoneForHr(bpm, hrMax, zones).color;
}
