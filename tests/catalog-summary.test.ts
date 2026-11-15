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

report();
