import { readFileSync } from 'node:fs';
import { setupDom } from './dom-setup';
setupDom();

const { parseZwo } = await import('../src/workout/zwo');
const { parseGpx } = await import('../src/activity/gpx');
const { Course } = await import('../src/activity/course');
const { summariseWorkout, summariseRoute, PROFILE_POINTS } = await import('../src/catalog/summary');
const { check, near, report, suite } = await import('./harness');

const zwo = (body: string) => parseZwo(`<workout_file><name>t</name><workout>${body}</workout></workout_file>`, { ftp: 250 });
const sum = (xs: number[]) => xs.reduce((s, v) => s + v, 0);

suite('a steady hour at 75%: TSS by hand is 1 h x 0.75² x 100 = 56.25', () => {
  const s = summariseWorkout(zwo('<SteadyState Duration="3600" Power="0.75"/>'));
  check('duration is an hour', s.duration === 3600);
  near('IF is 0.75', s.if, 0.75, 0.001);
  near('TSS is 56.25', s.tss, 56.25, 0.05);
  check('every second is in Z2 (75% is the top of endurance)', s.zones[1] === 3600 && sum(s.zones) === 3600,
    JSON.stringify(s.zones));
  check('one compact block', JSON.stringify(s.blocks) === '[[3600,0.75,0.75]]', JSON.stringify(s.blocks));
});

suite('a 600 s ramp from 50% to 100% splits across zones by its slope', () => {
  const s = summariseWorkout(zwo('<Ramp Duration="600" PowerLow="0.5" PowerHigh="1.0"/>'));
  // ratio = 0.5 + 0.5 t/600: Z1 to 0.55 at 60 s, Z2 to 0.75 at 300 s,
  // Z3 to 0.90 at 480 s, Z4 the remaining 120 s.
  check('Z1 60 s, Z2 240 s, Z3 180 s, Z4 120 s',
    JSON.stringify(s.zones) === JSON.stringify([60, 240, 180, 120, 0, 0, 0]), JSON.stringify(s.zones));
  check('compact block keeps both ends', JSON.stringify(s.blocks) === '[[600,0.5,1]]', JSON.stringify(s.blocks));
});

suite('IntervalsT expands into its on and off blocks', () => {
  const s = summariseWorkout(zwo('<IntervalsT Repeat="3" OnDuration="60" OffDuration="60" OnPower="1.2" OffPower="0.5"/>'));
  check('six compact blocks', s.blocks.length === 6);
  check('180 s at 120% land in Z5, 180 s at 50% in Z1', s.zones[4] === 180 && s.zones[0] === 180,
    JSON.stringify(s.zones));
  // NP of a square wave sits above its mean (0.85) and below its peak (1.2).
  check('IF above the average target and below the peak', s.if > 0.85 && s.if < 1.2, String(s.if));
  near('TSS is 6 min x IF² x 100', s.tss, (360 / 3600) * s.if ** 2 * 100, 0.06);
});

suite('free-ride blocks count in duration only: 30 min at 100% + 30 min free = TSS 50', () => {
  const s = summariseWorkout(zwo('<SteadyState Duration="1800" Power="1.0"/><FreeRide Duration="1800"/>'));
  check('duration is an hour', s.duration === 3600);
  check('only the ERG half is zoned', sum(s.zones) === 1800 && s.zones[3] === 1800, JSON.stringify(s.zones));
  near('IF is 1.0 over the ERG seconds', s.if, 1, 0.001);
  near('TSS is 0.5 h x 1² x 100', s.tss, 50, 0.05);
  check('the free block is compact with no targets', JSON.stringify(s.blocks[1]) === '[1800,null,null]');
});

suite('a workout that is all free riding scores nothing', () => {
  const s = summariseWorkout(zwo('<FreeRide Duration="600"/>'));
  check('TSS 0', s.tss === 0);
  check('no zone time', sum(s.zones) === 0);
});

suite('route summary equals the ride screen\'s Course', () => {
  const track = parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'sample');
  const course = new Course(track);
  const s = summariseRoute(track);
  near('distance matches', s.distance, course.totalDistance, 0.5);
  near('ascent matches', s.ascent, course.totalAscent, 0.5);
  check('starts at the first point', s.start[0] === Math.round(course.points[0].lat * 1e6) / 1e6
    && s.start[1] === Math.round(course.points[0].lon * 1e6) / 1e6);
  check(`profile has at most ${PROFILE_POINTS} points`, s.profile.length <= PROFILE_POINTS && s.profile.length >= 2,
    String(s.profile.length));
  check('profile runs from start to finish', s.profile[0][0] === 0
    && Math.abs(s.profile[s.profile.length - 1][0] - course.totalDistance) <= 0.5);
  check('profile distances never go backwards', s.profile.every((p, i, all) => i === 0 || p[0] >= all[i - 1][0]));
});

suite('a long route is thinned to the thumbnail size, evenly in distance', () => {
  const pts = Array.from({ length: 2000 }, (_, i) =>
    `<trkpt lat="${41.6 + i * 0.0001}" lon="41.6"><ele>${10 + Math.sin(i / 50) * 20}</ele></trkpt>`).join('');
  const track = parseGpx(`<gpx><trk><name>long</name><trkseg>${pts}</trkseg></trk></gpx>`, 'x');
  const s = summariseRoute(track);
  check(`exactly ${PROFILE_POINTS} points`, s.profile.length === PROFILE_POINTS, String(s.profile.length));
  const steps = s.profile.slice(1).map((p, i) => p[0] - s.profile[i][0]);
  check('steps are roughly even', Math.max(...steps) - Math.min(...steps) < 30, JSON.stringify([Math.min(...steps), Math.max(...steps)]));
});

suite('a Cyrillic route name survives', () => {
  const gpx = '<?xml version="1.0" encoding="UTF-8"?><gpx><trk><name>исследуем ближайшие холмы</name><trkseg>'
    + '<trkpt lat="41.6357" lon="41.6062"><ele>2</ele></trkpt><trkpt lat="41.6360" lon="41.6065"><ele>3</ele></trkpt>'
    + '</trkseg></trk></gpx>';
  const track = parseGpx(gpx, 'fallback');
  check('name unchanged', track.name === 'исследуем ближайшие холмы', track.name);
  check('summarises', summariseRoute(track).profile.length === 2);
});

suite('a route with one point is refused', () => {
  const track = parseGpx('<gpx><trk><trkseg><trkpt lat="1" lon="1"/></trkseg></trk></gpx>', 'x');
  let threw = false;
  try { summariseRoute(track); } catch { threw = true; }
  check('throws', threw);
});

report();
