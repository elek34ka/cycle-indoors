/** Coggan-style 7 power zones, expressed as upper bounds in % of FTP. */
export interface Zone { id: number; key: string; label: string; max: number; color: string; }

export const POWER_ZONES: Zone[] = [
  { id: 1, key: 'z1', label: 'Active recovery', max: 0.55, color: '#7a8694' },
  { id: 2, key: 'z2', label: 'Endurance',       max: 0.75, color: '#3f8fd8' },
  { id: 3, key: 'z3', label: 'Tempo',           max: 0.90, color: '#3fc07a' },
  { id: 4, key: 'z4', label: 'Threshold',       max: 1.05, color: '#f0c33c' },
  { id: 5, key: 'z5', label: 'VO2 max',         max: 1.20, color: '#f08a35' },
  { id: 6, key: 'z6', label: 'Anaerobic',       max: 1.50, color: '#e4563c' },
  { id: 7, key: 'z7', label: 'Neuromuscular',   max: Infinity, color: '#c2437f' },
];

export function zoneForRatio(ratio: number): Zone {
  for (const z of POWER_ZONES) if (ratio <= z.max) return z;
  return POWER_ZONES[POWER_ZONES.length - 1];
}

export function zoneForPower(watts: number, ftp: number): Zone {
  return zoneForRatio(ftp > 0 ? watts / ftp : 0);
}

/** 5 heart-rate zones as fraction of max HR. */
export const HR_ZONES = [
  { id: 1, max: 0.60, color: '#7a8694' },
  { id: 2, max: 0.70, color: '#3f8fd8' },
  { id: 3, max: 0.80, color: '#3fc07a' },
  { id: 4, max: 0.90, color: '#f08a35' },
  { id: 5, max: Infinity, color: '#e4563c' },
];

export function hrZoneColor(bpm: number, hrMax: number): string {
  const r = hrMax > 0 ? bpm / hrMax : 0;
  for (const z of HR_ZONES) if (r <= z.max) return z.color;
  return '#e4563c';
}
