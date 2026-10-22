import { readFileSync } from 'node:fs';
import { setupDom } from './dom-setup';
setupDom();

const { parseZwo } = await import('../src/workout/zwo');
const { parseGpx } = await import('../src/activity/gpx');
const { LIBRARY } = await import('../src/workout/library');
const { blockLabel, targetText, wattsText } = await import('../src/workout/targets');
const { check, near, report, suite } = await import('./harness');

const CTX = { ftp: 250 };

suite('every library workout parses', () => {
  for (const entry of LIBRARY) {
    const workout = parseZwo(entry.zwo, CTX);
    check(`${entry.title}: parses with blocks`, workout.segments.length > 0);
    check(`${entry.title}: duration matches the sum of its blocks`,
      Math.abs(workout.duration - workout.segments.reduce((s, x) => s + x.duration, 0)) < 0.001);
    check(`${entry.title}: blocks are contiguous`, workout.segments.every((s, i, all) =>
      i === 0 || Math.abs(s.start - (all[i - 1].start + all[i - 1].duration)) < 0.001));
  }
});

suite('the free-ride workouts have no targets at all', () => {
  for (const [id, hours] of [['free-ride-3h', 3], ['free-ride-4h', 4]] as const) {
    const entry = LIBRARY.find((e) => e.id === id)!;
    const workout = parseZwo(entry.zwo, CTX);
    near(`${id}: ${hours} hours long`, workout.duration, hours * 3600, 0.01);
    check(`${id}: one block per hour`, workout.segments.length === hours, String(workout.segments.length));
    check(`${id}: every block is free riding`, workout.segments.every((s) => s.mode === 'free'));
    check(`${id}: no block carries a power target`,
      workout.segments.every((s) => s.powerStart === undefined && s.powerEnd === undefined));
      check(`${id}: one message per hour`, workout.textEvents.length === hours,
      String(workout.textEvents.length));
    check(`${id}: the messages are spread across the ride`,
      workout.textEvents.every((e, i, all) => i === 0 || e.time > all[i - 1].time),
      JSON.stringify(workout.textEvents.map((e) => e.time)));
  }
});

suite('zwo block types', () => {
  const workout = parseZwo(`<workout_file>
    <name>Mixed</name><author>Tester</author><description>All block types</description>
    <sportType>bike</sportType>
    <workout>
      <Warmup Duration="300" PowerLow="0.40" PowerHigh="0.80"/>
      <SteadyState Duration="120" Power="0.95" Cadence="92">
        <textevent timeoffset="10" message="hold it" duration="8"/>
      </SteadyState>
      <IntervalsT Repeat="3" OnDuration="60" OffDuration="30" OnPower="1.20" OffPower="0.45" Cadence="100" CadenceResting="85"/>
      <FreeRide Duration="180" FlatRoad="1"/>
      <Ramp Duration="60" PowerLow="0.6" PowerHigh="1.0"/>
      <Cooldown Duration="300" PowerLow="0.40" PowerHigh="0.70"/>
    </workout></workout_file>`, CTX);

  check('name, author and description', workout.name === 'Mixed' && workout.author === 'Tester' && workout.description === 'All block types');
  check('repeats expand to 6 interval blocks', workout.segments.filter((s) => s.kind.startsWith('Interval')).length === 6);
  near('total duration', workout.duration, 300 + 120 + 3 * 90 + 180 + 60 + 300, 0.01);
  near('warm-up ramps up', workout.segments[0].powerEnd! - workout.segments[0].powerStart!, 0.4, 0.001);
  check('free ride has no target', workout.segments.find((s) => s.kind === 'FreeRide')?.powerStart === undefined);
  check('free ride is in free mode', workout.segments.find((s) => s.kind === 'FreeRide')?.mode === 'free');
  check('interval cadence targets are kept', workout.segments.find((s) => s.kind === 'IntervalOn')?.cadence === 100);
  check('rest cadence target is kept', workout.segments.find((s) => s.kind === 'IntervalOff')?.cadence === 85);
  check('interval blocks are named by repeat, rests "Recover"',
    JSON.stringify(workout.segments.filter((s) => s.kind.startsWith('Interval')).map((s) => s.name))
      === JSON.stringify(['1/3', 'Recover', '2/3', 'Recover', '3/3', 'Recover']),
    JSON.stringify(workout.segments.map((s) => s.name)));
  check('blocks described by their target alone have no name',
    ['Warmup', 'SteadyState', 'Ramp', 'Cooldown'].every((k) => workout.segments.find((s) => s.kind === k)?.name === undefined));
  check('labels are unchanged by naming', workout.segments.find((s) => s.kind === 'IntervalOn')?.label === '1/3 · 120% FTP');
  const cooldown = workout.segments[workout.segments.length - 1];
  check('a cooldown always descends regardless of attribute order',
    cooldown.powerStart! > cooldown.powerEnd!, `${cooldown.powerStart} -> ${cooldown.powerEnd}`);
  check('text event is captured at the right absolute time',
    workout.textEvents.length === 1 && workout.textEvents[0].time === 310, JSON.stringify(workout.textEvents));
});

suite('block targets are written in watts and percent', () => {
  const seg = (powerStart?: number, powerEnd?: number, name?: string) => ({
    index: 0, start: 0, duration: 600, powerStart, powerEnd, name,
    mode: powerStart === undefined ? 'free' as const : 'erg' as const, kind: 'Test', label: 'Free ride',
  });
  const eq = (title: string, got: string | undefined, want: string) => check(title, got === want, `got ${got}`);
  eq('rising ramp', targetText(seg(0.6, 0.8), 300), '180–240 W (60–80%)');
  eq('falling ramp keeps its direction', targetText(seg(0.8, 0.6), 300), '240–180 W (80–60%)');
  eq('steady block', targetText(seg(0.75, 0.75), 300), '225 W (75%)');
  eq('steady block without an end', targetText(seg(0.75), 300), '225 W (75%)');
  eq('named interval', blockLabel(seg(1.1, 1.1, '1/5'), 300), '1/5 · 330 W (110%)');
  eq('unnamed block is just its target', blockLabel(seg(0.6, 0.8), 300), '180–240 W (60–80%)');
  eq('free block keeps its label', blockLabel(seg(), 300), 'Free ride');
  check('free block has no target', targetText(seg(), 300) === undefined && wattsText(seg(), 300) === undefined);
  eq('graph form of a ramp', wattsText(seg(0.6, 0.8), 300), '180–240 W');
  eq('graph form of a steady block', wattsText(seg(0.75, 0.75), 300), '225 W');
  eq('a near-flat ramp is written as steady', targetText(seg(0.75, 0.751), 300), '225 W (75%)');
  eq('watts are rounded to the nearest watt', targetText(seg(0.55), 222), '122 W (55%)');
});

suite('zwo edge cases', () => {
  const watts = parseZwo(`<workout_file><name>W</name><workout>
      <SteadyState Duration="60" Power="200"/></workout></workout_file>`, CTX);
  near('absolute watts are normalised against FTP', watts.segments[0].powerStart!, 200 / 250, 0.001);

  let threw = false;
  try { parseZwo('<nope/>', CTX); } catch { threw = true; }
  check('a non-workout XML file is rejected', threw);

  threw = false;
  try { parseZwo('not xml at all <<<', CTX); } catch { threw = true; }
  check('malformed XML is rejected', threw);

  const unknown = parseZwo(`<workout_file><name>U</name><workout>
      <Pyramid Duration="120"/><SteadyState Duration="60" Power="0.6"/></workout></workout_file>`, CTX);
  near('an unknown block still occupies its time', unknown.duration, 180, 0.01);
});

suite('gpx parsing', () => {
  const gpx = `<?xml version="1.0"?>
  <gpx version="1.1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
    <trk><name>Morning ride</name><trkseg>
      <trkpt lat="50.0600" lon="19.9400"><ele>210</ele><time>2026-10-17T06:00:00Z</time>
        <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>120</gpxtpx:hr><gpxtpx:cad>84</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>
      <trkpt lat="50.0700" lon="19.9400"><ele>240</ele><time>2026-10-17T06:05:00Z</time>
        <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>148</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
      <trkpt lat="50.0800" lon="19.9400"><ele>225</ele><time>2026-10-17T06:10:00Z</time></trkpt>
    </trkseg></trk></gpx>`;
  const track = parseGpx(gpx, 'fallback');
  check('track name comes from <trk>', track.name === 'Morning ride', track.name);
  check('all three points are read', track.points.length === 3);
  near('distance is about 2.2 km for 0.02 degrees of latitude', track.distance, 2224, 40);
  check('elevation is detected', track.hasElevation);
  check('heart rate is read from the Garmin extension', track.hasHr && Math.round(track.avgHr!) === 134,
    `avg ${track.avgHr}`);
  near('ascent over the short climb', track.ascent, 30, 0.01);
  near('descent over the short drop', track.descent, 15, 0.01);
  near('elapsed time from timestamps', track.elapsed!, 600, 0.01);
  check('cumulative distance increases', track.points.every((p, i, all) => i === 0 || p.distance > all[i - 1].distance));

  let threw = false;
  try { parseGpx('<gpx></gpx>', 'x'); } catch { threw = true; }
  check('a GPX with no points is rejected', threw);
});

suite('the shipped sample files load', () => {
  const zwo = parseZwo(readFileSync('samples/sample-over-unders.zwo', 'utf8'), CTX);
  check('the sample workout parses', zwo.name === 'Over-unders 3 x 9', zwo.name);
  near('it is 65 minutes long', zwo.duration / 60, 65, 0.5);
  check('it has a free-ride block', zwo.segments.some((x) => x.mode === 'free'));
  check('it carries four text events', zwo.textEvents.length === 4, String(zwo.textEvents.length));
  check('every block has a label', zwo.segments.every((x) => x.label.length > 0));

  const gpx = parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'fallback');
  check('the sample route parses', gpx.points.length === 420, String(gpx.points.length));
  check('it has power, HR and elevation', gpx.hasPower && gpx.hasHr && gpx.hasElevation);
  check('its distance is a plausible loop', gpx.distance > 8000 && gpx.distance < 30000,
    `${Math.round(gpx.distance)} m`);
  check('smoothing keeps ascent and descent close on a loop',
    Math.abs(gpx.ascent - gpx.descent) / gpx.ascent < 0.25,
    `+${Math.round(gpx.ascent)} / -${Math.round(gpx.descent)}`);
  check('the loop returns near its start',
    Math.abs(gpx.points[0].lat - gpx.points[419].lat) < 0.01, 'start/finish drift');
});

report();
