import { Decoder, Stream } from '@garmin/fitsdk';
import { FitEncoder } from '../src/fit/encoder';
import { toFitTime } from '../src/fit/crc';
import { decodeFit } from '../src/fit/decoder';
import { parseFitWorkout } from '../src/workout/fit-workout';
import { check, near, report, suite } from './harness';

/** Build a FIT workout: 10 min warm-up, then 4 x (3 min @ 105% FTP / 3 min @ 50%), 5 min cool-down. */
function buildWorkoutFile(): Uint8Array {
  const enc = new FitEncoder();
  enc.message(0, 0, [
    { num: 0, type: 'enum', value: 5 }, // workout file
    { num: 1, type: 'uint16', value: 255 },
    { num: 4, type: 'uint32', value: toFitTime(new Date('2026-10-17T06:00:00Z')) },
  ]);
  enc.message(1, 26, [
    { num: 8, type: 'string', value: 'Threshold 4 x 3', size: 16 },
    { num: 4, type: 'enum', value: 2 },   // sport: cycling
    { num: 6, type: 'uint16', value: 5 }, // num_valid_steps
  ]);

  type Step = {
    index: number; durationType: number; durationValue: number;
    targetType: number; targetValue: number; low: number; high: number; intensity: number; name?: string;
  };
  const steps: Step[] = [
    { index: 0, durationType: 0, durationValue: 600_000, targetType: 4, targetValue: 0, low: 55, high: 65, intensity: 2, name: 'Warm up' },
    { index: 1, durationType: 0, durationValue: 180_000, targetType: 4, targetValue: 0, low: 103, high: 107, intensity: 5, name: 'On' },
    { index: 2, durationType: 0, durationValue: 180_000, targetType: 4, targetValue: 0, low: 48, high: 52, intensity: 1, name: 'Off' },
    // repeat steps 1-2 until 4 repetitions are complete
    { index: 3, durationType: 6, durationValue: 1, targetType: 2, targetValue: 4, low: 0, high: 0, intensity: 6 },
    { index: 4, durationType: 0, durationValue: 300_000, targetType: 4, targetValue: 0, low: 1150, high: 1150, intensity: 3, name: 'Cool down' },
  ];

  for (const s of steps) {
    enc.message(2, 27, [
      { num: 254, type: 'uint16', value: s.index },
      { num: 0, type: 'string', value: s.name ?? '', size: 16 },
      { num: 1, type: 'enum', value: s.durationType },
      { num: 2, type: 'uint32', value: s.durationValue },
      { num: 3, type: 'enum', value: s.targetType },
      { num: 4, type: 'uint32', value: s.targetValue },
      { num: 5, type: 'uint32', value: s.low },
      { num: 6, type: 'uint32', value: s.high },
      { num: 7, type: 'enum', value: s.intensity },
    ]);
  }
  return enc.finish();
}

const bytes = buildWorkoutFile();
const asArrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

suite('Garmin SDK confirms the workout field numbers', () => {
  const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)));
  check('integrity check passes', decoder.checkIntegrity());
  const { messages, errors } = decoder.read();
  check('no decode errors', errors.length === 0, JSON.stringify(errors.slice(0, 2)));
  check('file type is workout', messages.fileIdMesgs?.[0]?.type === 'workout', `got ${messages.fileIdMesgs?.[0]?.type}`);
  check('workout name maps to wktName', messages.workoutMesgs?.[0]?.wktName === 'Threshold 4 x 3',
    `got ${messages.workoutMesgs?.[0]?.wktName}`);
  check('sport maps to cycling', messages.workoutMesgs?.[0]?.sport === 'cycling');
  const step = messages.workoutStepMesgs?.[1];
  check('step name maps to wktStepName', step?.wktStepName === 'On', `got ${step?.wktStepName}`);
  check('duration type maps to time', step?.durationType === 'time', `got ${step?.durationType}`);
  check('duration value is milliseconds', step?.durationTime === 180 || step?.durationValue === 180000,
    `got durationTime=${step?.durationTime} durationValue=${step?.durationValue}`);
  check('target type maps to power', step?.targetType === 'power', `got ${step?.targetType}`);
  check('custom low maps to a power field', step?.customTargetPowerLow === 103 || step?.customTargetValueLow === 103,
    `got ${step?.customTargetPowerLow ?? step?.customTargetValueLow}`);
  check('intensity maps to interval', step?.intensity === 'interval', `got ${step?.intensity}`);
  const repeat = messages.workoutStepMesgs?.[3];
  check('repeat step maps to repeatUntilStepsCmplt', repeat?.durationType === 'repeatUntilStepsCmplt',
    `got ${repeat?.durationType}`);
});

suite('parseFitWorkout expands the workout', () => {
  const workout = parseFitWorkout(decodeFit(asArrayBuffer), { ftp: 250 }, 'fallback');
  check('name comes from the file', workout.name === 'Threshold 4 x 3', `got ${workout.name}`);
  check('repeats expand to 10 blocks', workout.segments.length === 10, `got ${workout.segments.length}`);
  near('total duration', workout.duration, 600 + 4 * 360 + 300, 0.01);
  near('warm-up target is the midpoint of 55-65% FTP', workout.segments[0].powerStart!, 0.6, 0.001);
  near('interval target is the midpoint of 103-107% FTP', workout.segments[1].powerStart!, 1.05, 0.001);
  check('interval blocks alternate', workout.segments[2].powerStart! < workout.segments[1].powerStart!);
  near('absolute-watt target converts against FTP', workout.segments[9].powerStart!, 150 / 250, 0.001);
  check('a named step keeps its name', workout.segments[1].name === 'On' && workout.segments[0].name === 'Warm up',
    `${workout.segments[0].name}, ${workout.segments[1].name}`);
  check('every block is in ERG mode', workout.segments.every((s) => s.mode === 'erg'));
  check('blocks are contiguous in time', workout.segments.every((s, i, all) =>
    i === 0 || Math.abs(s.start - (all[i - 1].start + all[i - 1].duration)) < 0.001));
  check('no warnings for a fully specified workout', (workout.warnings ?? []).length === 0,
    JSON.stringify(workout.warnings));
});

report();
