import { dec, hhmmss, int, km } from '../core/format';
import type { RideMetrics } from '../session/metrics';

export type SummaryKey =
  | 'duration' | 'distance' | 'avgPower' | 'normalisedPower' | 'maxPower' | 'intensity'
  | 'tss' | 'work' | 'avgHr' | 'avgCadence' | 'avgSpeed' | 'climbed' | 'onTarget' | 'laps';

/** One number the summary shows. `value` is `--` when the ride has none. */
export interface SummaryValue {
  key: SummaryKey;
  label: string;
  value: string;
  /** what `value` is measured in, when it has a unit */
  unit?: string;
  /** shown in place of the unit, e.g. "max 174" under the average heart rate */
  note?: string;
}

/** The small text under a value: its note if it has one, else its unit. */
export const subText = (v: SummaryValue): string | undefined => v.note ?? v.unit;

/** `--`, the summary's mark for a value the ride does not have. */
export const isMissing = (v: SummaryValue): boolean => v.value === '--';

/**
 * Every value the summary shows, formatted once. The grid, the stats image
 * and the Strava description all read this list, so none of them can round
 * or label a number differently from the others.
 */
export function summaryValues(metrics: RideMetrics, lapCount: number): SummaryValue[] {
  const m = metrics;
  const values: (SummaryValue | null)[] = [
    { key: 'duration', label: 'Duration', value: hhmmss(m.duration) },
    { key: 'distance', label: 'Distance', value: km(m.distance), unit: 'km' },
    { key: 'avgPower', label: 'Avg power', value: int(m.avgPower), unit: 'W' },
    { key: 'normalisedPower', label: 'Normalised', value: int(m.normalisedPower), unit: 'W' },
    { key: 'maxPower', label: 'Max power', value: int(m.maxPower), unit: 'W' },
    { key: 'intensity', label: 'Intensity', value: dec(m.intensityFactor, 2), note: 'IF' },
    { key: 'tss', label: 'TSS', value: int(m.tss) },
    { key: 'work', label: 'Work', value: int(m.work), unit: 'kJ' },
    {
      key: 'avgHr',
      label: 'Avg HR',
      value: int(m.avgHr),
      ...(m.avgHr !== undefined ? { unit: 'bpm' } : {}),
      ...(m.maxHr ? { note: `max ${Math.round(m.maxHr)}` } : {}),
    },
    { key: 'avgCadence', label: 'Avg cadence', value: int(m.avgCadence), unit: 'rpm' },
    { key: 'avgSpeed', label: 'Avg speed', value: dec(m.avgSpeed, 1), unit: 'km/h' },
    m.hasPosition
      ? { key: 'climbed', label: 'Climbed', value: int(m.ascent), unit: 'm', note: `${Math.round(m.descent)} m down` }
      : null,
    m.compliance === undefined
      ? { key: 'laps', label: 'Laps', value: String(Math.max(1, lapCount)) }
      : { key: 'onTarget', label: 'On target', value: `${Math.round(m.compliance)}%`, note: 'vs. workout' },
  ];
  return values.filter((v): v is SummaryValue => v !== null);
}
