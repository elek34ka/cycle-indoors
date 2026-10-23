import { routeDistances, valueAt, type SmoothedProfile } from './smoothing';
import type { ActivityTrack } from './types';

export interface CoursePoint {
  lat: number;
  lon: number;
  ele?: number;
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

/** A GPX 1.1 course: one track, positions and heights only. No times and no
 *  sensor extensions: this is a route to ride, and someone's old heart rate
 *  or power would read as data in other tools. */
export function buildGpx(name: string, points: CoursePoint[]): string {
  const safe = escapeXml(name);
  const rows = points.map((p) => {
    const ele = p.ele === undefined ? '' : `<ele>${p.ele.toFixed(2)}</ele>`;
    return `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${ele}</trkpt>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Cycle Indoors" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${safe}</name></metadata>`,
    '  <trk>',
    `    <name>${safe}</name>`,
    '    <type>cycling</type>',
    '    <trkseg>',
    ...rows,
    '    </trkseg>',
    '  </trk>',
    '</gpx>',
    '',
  ].join('\n');
}

/** The original GPS points, in order, each given the smoothed height at its
 *  own distance along the route. Interpolating a piecewise-linear profile
 *  cannot make a segment steeper than the profile, so the limits still hold. */
export function smoothedTrackPoints(track: ActivityTrack, profile: SmoothedProfile): CoursePoint[] {
  const points = track.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  const distances = routeDistances(points);
  return points.map((p, i) => ({ lat: p.lat, lon: p.lon, ele: valueAt(profile, profile.smoothed, distances[i]) }));
}
