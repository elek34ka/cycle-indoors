import { hhmmss } from '../core/format';
import type { ZoneTime } from '../session/metrics';
import { isMissing, type SummaryKey, type SummaryValue } from '../ui/summary-values';

export const DESCRIPTION_CREDIT = 'Ridden on Cycle Indoors';

export interface DescriptionInput {
  /** the route loaded at Finish */
  route?: string;
  /** the workout loaded at Finish; undefined for a free ride */
  workout?: string;
  /** the summary's values, so every number reads as it does there */
  values: readonly SummaryValue[];
  /** rounded max heart rate, as the summary notes it under the average */
  maxHr?: number;
  zones: readonly ZoneTime[];
  hrZones: readonly ZoneTime[];
}

/**
 * The text a Strava upload carries: what was ridden, the summary's numbers,
 * time in zones, and a credit. Values the ride does not have are left out,
 * and so is any line left with nothing in it.
 */
export function stravaDescription(input: DescriptionInput): string {
  const byKey = new Map(input.values.filter((v) => !isMissing(v)).map((v) => [v.key, v]));
  /** "<label> <value> <unit>", or nothing when the ride has no such value */
  const part = (key: SummaryKey, label: string, unit?: string) => {
    const v = byKey.get(key);
    if (!v) return undefined;
    const u = unit ?? v.unit;
    return `${label ? `${label} ` : ''}${v.value}${u ? ` ${u}` : ''}`;
  };
  const line = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ');

  const ridden = [
    input.route ? `Route: ${input.route}` : '',
    input.workout ? `Workout: ${input.workout}` : '',
  ];

  const power = [part('avgPower', 'avg'), part('normalisedPower', 'NP'), part('maxPower', 'max')].filter(Boolean);
  const hr = byKey.has('avgHr')
    ? line(part('avgHr', 'avg'), input.maxHr !== undefined ? `max ${input.maxHr} bpm` : undefined)
    : '';
  const numbers = [
    line(part('duration', 'Duration'), part('distance', 'Distance')),
    power.length ? `Power ${power.join(' · ')}` : '',
    line(part('intensity', 'IF', ''), part('tss', 'TSS'), part('work', 'Work')),
    hr ? `Heart rate ${hr}` : '',
    line(part('avgCadence', 'Cadence'), part('avgSpeed', 'Speed')),
    line(part('climbed', 'Climbed'), byKey.has('onTarget') ? `On target ${byKey.get('onTarget')!.value}` : undefined),
  ];

  const zoneLine = (title: string, zones: readonly ZoneTime[]) => {
    const spent = zones.filter((z) => z.seconds > 0).map((z) => `Z${z.zone} ${hhmmss(z.seconds)}`);
    return spent.length ? `${title}: ${spent.join(' · ')}` : '';
  };
  const zones = [
    zoneLine('Power zones', input.zones),
    byKey.has('avgHr') ? zoneLine('HR zones', input.hrZones) : '',
  ];

  // Blocks of lines, a blank line between blocks; empty lines and empty blocks drop out.
  return [ridden, numbers, zones, [DESCRIPTION_CREDIT]]
    .map((block) => block.filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
}
