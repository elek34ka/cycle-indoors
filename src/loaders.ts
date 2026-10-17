import { decodeFit } from './fit/decoder';
import { parseFitWorkout } from './workout/fit-workout';
import { parseZwo } from './workout/zwo';
import { parseGpx } from './activity/gpx';
import { trackFromFit } from './activity/fit-activity';
import type { Workout } from './workout/types';
import type { ActivityTrack } from './activity/types';

export interface LoadResult {
  workout?: Workout;
  track?: ActivityTrack;
  fileName: string;
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || 'Untitled';
}

export async function loadFile(file: File, ctx: { ftp: number }): Promise<LoadResult> {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  const label = baseName(file.name);

  if (ext === 'zwo' || ext === 'xml') {
    const text = await file.text();
    if (text.includes('<gpx')) return { track: parseGpx(text, label), fileName: file.name };
    return { workout: parseZwo(text, ctx), fileName: file.name };
  }

  if (ext === 'gpx') {
    return { track: parseGpx(await file.text(), label), fileName: file.name };
  }

  if (ext === 'fit') {
    const fit = decodeFit(await file.arrayBuffer());
    const hasSteps = (fit.byName.get('workout_step')?.length ?? 0) > 0;
    const hasRecords = (fit.byName.get('record')?.length ?? 0) > 0;
    const result: LoadResult = { fileName: file.name };
    if (hasSteps) result.workout = parseFitWorkout(fit, ctx, label);
    if (hasRecords) result.track = trackFromFit(fit, label);
    if (!result.workout && !result.track) {
      throw new Error('This FIT file has neither workout steps nor ride records');
    }
    return result;
  }

  // Unknown extension: sniff the content.
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const magic = String.fromCharCode(...head.subarray(8, 12));
  if (magic === '.FIT') {
    const synthetic = new File([await file.arrayBuffer()], `${label}.fit`, { type: file.type });
    return loadFile(synthetic, ctx);
  }
  const text = await file.text();
  if (text.includes('<workout_file')) return { workout: parseZwo(text, ctx), fileName: file.name };
  if (text.includes('<gpx')) return { track: parseGpx(text, label), fileName: file.name };
  throw new Error(`Unsupported file "${file.name}" — load a .zwo, .fit or .gpx file`);
}
