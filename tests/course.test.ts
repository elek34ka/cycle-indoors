import { setupDom } from './dom-setup';
setupDom();

const { Course, gradientColor } = await import('../src/activity/course');
const { distanceForX, xForDistance, ElevationGraph } = await import('../src/ui/elevation-graph');
const { parseGpx } = await import('../src/activity/gpx');
const { readFileSync } = await import('node:fs');
const { check, near, report, suite } = await import('./harness');
import type { ActivityTrack, TrackPoint } from '../src/activity/types';
import type { SessionSnapshot } from '../src/session/session';

/** 1 km flat at 100 m, 1 km climbing to 200 m (10%), 1 km back down to 100 m. */
function syntheticTrack(): ActivityTrack {
  const points: TrackPoint[] = [];
  for (let d = 0; d <= 3000; d += 10) {
    let ele = 100;
    if (d > 1000 && d <= 2000) ele = 100 + (d - 1000) * 0.1;
    else if (d > 2000) ele = 200 - (d - 2000) * 0.1;
    points.push({ lat: 50 + d / 111320, lon: 19, ele, distance: d });
  }
  return {
    name: 'Synthetic', source: 'gpx', points, distance: 3000, ascent: 0, descent: 0,
    hasPower: false, hasHr: false, hasElevation: true,
  };
}

const course = new Course(syntheticTrack());

suite('course geometry', () => {
  near('total distance', course.totalDistance, 3000, 1);
  near('total ascent', course.totalAscent, 100, 2);
  near('total descent', course.totalDescent, 100, 4);
  near('lowest point', course.minEle, 100, 1);
  near('highest point', course.maxEle, 200, 2);

  near('the flat section reads as flat', course.at(500).gradient, 0, 0.3);
  near('the climb reads as 10%', course.at(1500).gradient, 10, 0.3);
  near('the descent reads as -10%', course.at(2500).gradient, -10, 0.3);
  near('elevation halfway up the climb', course.at(1500).ele, 150, 1.5);
  near('ascent halfway up the climb', course.at(1500).ascent, 50, 2);
  near('ascent at the top', course.at(2000).ascent, 100, 2);
  near('ascent does not grow on the descent', course.at(2999).ascent, 100, 2);
  check('the very end of the course wraps to the start of the next lap',
    course.at(3000).loops === 1 && course.at(3000).distance === 0);
});

suite('lapping the course', () => {
  const second = course.at(course.totalDistance + 1500);
  check('a second lap is counted', second.loops === 1, String(second.loops));
  near('position wraps to the same place on the lap', second.distance, 1500, 1);
  near('ascent accumulates across laps', second.totalAscent, 150, 3);
  const third = course.at(course.totalDistance * 2 + 2000);
  check('three laps in', third.loops === 2, String(third.loops));
  near('ascent after two full laps plus a climb', third.totalAscent, 3 * course.totalAscent, 2);
});

suite('gradient colours', () => {
  check('a descent is blue', gradientColor(-6) === '#5bc8f5');
  check('flat is grey', gradientColor(0) === '#7a8694');
  check('a gentle rise is green', gradientColor(3) === '#3fc07a');
  check('a hard climb is orange', gradientColor(8) === '#f08a35');
  check('a wall is magenta', gradientColor(20) === '#b02a7a');
  check('the scale is monotonic in distinct colours',
    new Set([-10, -1, 2, 5, 8, 12, 20].map(gradientColor)).size === 7);
});

suite('the elevation cursor maps to the right place on the course', () => {
  // This is the bug from the first pass: the cursor used the full canvas width
  // while the profile was drawn inside a padded plot area, so it ran ahead.
  const plot = { x: 44, y: 20, w: 200, h: 80 };
  const total = 3000;
  near('the left edge of the plot is the start', distanceForX(44, plot, total)!, 0, 0.001);
  near('the right edge is the finish', distanceForX(244, plot, total)!, 3000, 0.001);
  near('the middle is halfway', distanceForX(144, plot, total)!, 1500, 0.001);
  check('x inside the left padding is off the course', distanceForX(20, plot, total) === undefined);
  check('x past the right edge is off the course', distanceForX(260, plot, total) === undefined);

  let worst = 0;
  for (let d = 0; d <= total; d += 37) {
    const back = distanceForX(xForDistance(d, plot, total), plot, total);
    worst = Math.max(worst, Math.abs((back ?? -1) - d));
  }
  near('drawing and hit-testing agree exactly', worst, 0, 0.0001);
});

suite('the elevation readout is large and clear of the profile', () => {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.append(canvas);
  document.body.append(host);
  const drawn: { text: string; font: string; y: number }[] = [];
  const realGetContext = canvas.getContext.bind(canvas);
  canvas.getContext = ((kind: string) => {
    const ctx = realGetContext(kind as '2d') as unknown as Record<string, unknown>;
    ctx.fillText = (text: string, _x: number, y: number) => { drawn.push({ text, font: String(ctx.font), y }); };
    return ctx;
  }) as typeof canvas.getContext;
  const graph = new ElevationGraph(canvas, () => {});
  graph.setCourse(course);
  graph.render({ coursePosition: { distance: 1300, ele: 130, gradient: -1.4, totalAscent: 16 } } as unknown as SessionSnapshot);
  canvas.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 150, clientY: 60, bubbles: true }));
  host.remove();

  const fontOf = (text: string) => drawn.find((d) => d.text === text)?.font ?? 'not drawn';
  const readout = ['130 m', '-1.4%', '↑ 16 m'];
  for (const text of readout) check(`"${text}" is drawn at 24 px`, /\b24px\b/.test(fontOf(text)), fontOf(text));
  check('and bold', readout.every((text) => /^600 /.test(fontOf(text))), fontOf('130 m'));

  // the axis labels: the top elevation is drawn 4 px below the plot's top
  const maxLabel = drawn.find((d) => d.text === String(Math.round(course.maxEle)));
  check('the axis labels stay at 12 px', /\b12px\b/.test(maxLabel?.font ?? ''), maxLabel?.font ?? 'not drawn');
  const hover = drawn.find((d) => d.text.includes(' km · '));
  check('the hover readout stays at 13 px', /\b13px\b/.test(hover?.font ?? ''), hover?.font ?? 'not drawn');

  const plotTop = (maxLabel?.y ?? 0) - 4;
  // 24 px text drawn baseline-middle reaches 12 px below its y
  const readoutBottom = Math.max(...readout.map((text) => (drawn.find((d) => d.text === text)?.y ?? Infinity) + 12));
  check('the readout ends above the plotted profile', readoutBottom <= plotTop, `${readoutBottom} vs ${plotTop}`);
});

suite('the sample route becomes a rideable course', () => {
  const track = parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'sample');
  const loop = new Course(track);
  check('it has elevation', loop.hasElevation);
  check('ascent is in a sane range for a 20 km loop', loop.totalAscent > 100 && loop.totalAscent < 900,
    `${Math.round(loop.totalAscent)} m`);
  check('gradients stay inside the clamp',
    loop.points.every((p) => p.gradient >= -25 && p.gradient <= 25));
  check('gradients are not all zero', loop.points.some((p) => Math.abs(p.gradient) > 1));
  check('ascent never decreases along the course',
    loop.points.every((p, i, all) => i === 0 || p.ascent >= all[i - 1].ascent));
  check('distance lookup is monotonic',
    [0, 1000, 5000, 12000, loop.totalDistance].every((d, i, all) =>
      i === 0 || loop.indexForDistance(d) >= loop.indexForDistance(all[i - 1])));
});

report();
