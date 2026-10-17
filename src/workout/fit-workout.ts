import type { FitFile } from '../fit/decoder';
import type { Segment, Workout } from './types';

// wkt_step_duration
const DUR_TIME = 0;
const DUR_OPEN = 5;
const DUR_REPEAT_STEPS = 6;
// wkt_step_target
const TGT_HEART_RATE = 1;
const TGT_CADENCE = 3;
const TGT_POWER = 4;
const TGT_POWER_3S = 7;
const TGT_POWER_10S = 8;
const TGT_POWER_30S = 9;

const POWER_TARGETS = new Set([TGT_POWER, TGT_POWER_3S, TGT_POWER_10S, TGT_POWER_30S]);

/** Zone midpoints used when a step targets a power zone rather than a value. */
const ZONE_MID = [0, 0.4, 0.65, 0.83, 0.98, 1.12, 1.35, 1.6];

const INTENSITY_LABEL: Record<number, string> = {
  0: 'Active', 1: 'Rest', 2: 'Warm up', 3: 'Cool down', 4: 'Recovery', 5: 'Interval', 6: 'Other',
};

const OPEN_STEP_DEFAULT = 300;
const MAX_STEPS = 5000;

interface Step {
  index: number;
  name?: string;
  durationType: number;
  durationValue: number;
  targetType: number;
  targetValue: number;
  customLow: number;
  customHigh: number;
  intensity: number;
}

function n(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** FIT custom power targets: 0-1000 is % of FTP, 1000+ is (watts + 1000). */
function powerRatio(raw: number, ftp: number): number | undefined {
  if (raw <= 0) return undefined;
  return raw > 1000 ? (raw - 1000) / ftp : raw / 100;
}

export function parseFitWorkout(fit: FitFile, ctx: { ftp: number }, fallbackName: string): Workout {
  const raw = fit.byName.get('workout_step') ?? [];
  if (raw.length === 0) throw new Error('FIT file has no workout_step messages');

  const steps: Step[] = raw.map((m, i) => ({
    index: n(m.fields.message_index, i),
    name: typeof m.fields.wkt_step_name === 'string' ? m.fields.wkt_step_name : undefined,
    durationType: n(m.fields.duration_type, DUR_OPEN),
    durationValue: n(m.fields.duration_value),
    targetType: n(m.fields.target_type, 2),
    targetValue: n(m.fields.target_value),
    customLow: n(m.fields.custom_target_value_low),
    customHigh: n(m.fields.custom_target_value_high),
    intensity: n(m.fields.intensity, 0),
  }));
  steps.sort((a, b) => a.index - b.index);
  const byIndex = new Map(steps.map((s) => [s.index, s]));

  const warnings: string[] = [];
  const segments: Segment[] = [];
  let cursor = 0;
  const repeatsDone = new Map<number, number>();

  let cursorStep = 0;
  let guard = 0;
  while (cursorStep < steps.length && guard++ < MAX_STEPS) {
    const step = steps[cursorStep];

    if (step.durationType === DUR_REPEAT_STEPS) {
      const reps = Math.max(1, step.targetValue || 1);
      const done = (repeatsDone.get(step.index) ?? 0) + 1;
      if (done < reps) {
        repeatsDone.set(step.index, done);
        const target = byIndex.get(step.durationValue);
        const jumpTo = target ? steps.indexOf(target) : -1;
        if (jumpTo >= 0 && jumpTo < cursorStep) { cursorStep = jumpTo; continue; }
        warnings.push(`Repeat at step ${step.index} points outside the workout; ran it once.`);
      }
      repeatsDone.delete(step.index);
      cursorStep++;
      continue;
    }

    if (step.durationType >= 7 && step.durationType <= 13) {
      warnings.push(`Step ${step.index + 1} repeats on a condition this app cannot evaluate; ran it once.`);
      cursorStep++;
      continue;
    }

    let duration: number;
    if (step.durationType === DUR_TIME) {
      duration = step.durationValue / 1000;
    } else {
      duration = OPEN_STEP_DEFAULT;
      warnings.push(`Step ${step.index + 1} has no fixed duration; using ${OPEN_STEP_DEFAULT / 60} min of free riding.`);
    }

    let powerStart: number | undefined;
    let powerEnd: number | undefined;
    let cadence: number | undefined;

    if (POWER_TARGETS.has(step.targetType)) {
      const low = powerRatio(step.customLow, ctx.ftp);
      const high = powerRatio(step.customHigh, ctx.ftp);
      if (low !== undefined || high !== undefined) {
        const mid = low !== undefined && high !== undefined ? (low + high) / 2 : (low ?? high)!;
        powerStart = mid;
        powerEnd = mid;
      } else if (step.targetValue >= 1 && step.targetValue <= 7) {
        powerStart = ZONE_MID[step.targetValue];
        powerEnd = powerStart;
      }
    } else if (step.targetType === TGT_CADENCE) {
      cadence = step.customLow && step.customHigh
        ? Math.round((step.customLow + step.customHigh) / 2)
        : step.targetValue || undefined;
    } else if (step.targetType === TGT_HEART_RATE) {
      warnings.push(`Step ${step.index + 1} targets heart rate; ERG mode needs power, so it rides free.`);
    }

    if (duration <= 0) { cursorStep++; continue; }

    const label = step.name
      ?? (powerStart !== undefined
        ? `${INTENSITY_LABEL[step.intensity] ?? 'Step'} · ${Math.round(powerStart * 100)}% FTP`
        : INTENSITY_LABEL[step.intensity] ?? 'Free ride');

    segments.push({
      index: segments.length,
      start: cursor,
      duration,
      powerStart,
      powerEnd,
      cadence,
      mode: powerStart === undefined ? 'free' : 'erg',
      kind: INTENSITY_LABEL[step.intensity] ?? 'Step',
      label,
    });
    cursor += duration;
    cursorStep++;
  }

  if (segments.length === 0) throw new Error('FIT workout produced no ridable steps');

  const header = fit.byName.get('workout')?.[0]?.fields;
  const name = typeof header?.wkt_name === 'string' && header.wkt_name ? header.wkt_name : fallbackName;

  return {
    name,
    description: undefined,
    sport: 'bike',
    duration: cursor,
    segments,
    textEvents: [],
    source: 'fit',
    warnings: [...new Set(warnings)],
  };
}
