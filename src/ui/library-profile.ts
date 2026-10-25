import { zoneForRatio } from '../core/zones';
import type { CompactBlock } from '../catalog/types';

/** Free-ride blocks have no target; they are drawn low and grey. */
const FREE_RATIO = 0.45;
const FREE_COLOR = '#3a4656';
/** Never scale a profile to less than this, so an easy workout looks easy. */
const MIN_PEAK = 1.2;

export interface BlockShape {
  /** polygon corners: bottom-left, top-left, top-right, bottom-right */
  points: [number, number][];
  color: string;
}

/**
 * A workout's blocks as polygons in a `width` x `height` box: x by time, y by
 * fraction of FTP (taller is harder), coloured by the zone of the block's
 * mean target. Pure, so the drawing and its tests share one source of truth.
 */
export function workoutShapes(blocks: CompactBlock[], width: number, height: number): BlockShape[] {
  const total = blocks.reduce((s, b) => s + b[0], 0);
  if (total <= 0) return [];
  const peak = Math.max(MIN_PEAK, ...blocks.flatMap((b) => [b[1] ?? 0, b[2] ?? 0]));
  const y = (ratio: number) => height - (Math.min(ratio, peak) / peak) * height;
  const shapes: BlockShape[] = [];
  let t = 0;
  for (const [duration, start, end] of blocks) {
    const x0 = (t / total) * width;
    t += duration;
    const x1 = (t / total) * width;
    const from = start ?? FREE_RATIO;
    const to = end ?? from;
    shapes.push({
      points: [[x0, height], [x0, y(from)], [x1, y(to)], [x1, height]],
      color: start === null ? FREE_COLOR : zoneForRatio((from + to) / 2).color,
    });
  }
  return shapes;
}

/**
 * A route's elevation as a polyline in a `width` x `height` box: x by
 * distance, y by elevation between the route's lowest and highest points. A
 * flat route sits mid-height rather than dividing by zero.
 */
export function routeLine(profile: [number, number][], width: number, height: number): [number, number][] {
  if (profile.length === 0) return [];
  const start = profile[0][0];
  const span = profile[profile.length - 1][0] - start;
  const eles = profile.map((p) => p[1]);
  const lo = Math.min(...eles);
  const hi = Math.max(...eles);
  // a little headroom so the summit line is not clipped by the box edge
  const pad = height * 0.08;
  return profile.map(([d, e]) => [
    span > 0 ? ((d - start) / span) * width : 0,
    hi > lo ? height - pad - ((e - lo) / (hi - lo)) * (height - 2 * pad) : height / 2,
  ]);
}

const SVG = 'http://www.w3.org/2000/svg';
const fmt = (points: [number, number][]) => points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

function svg(width: number, height: number, cls: string): SVGSVGElement {
  const root = document.createElementNS(SVG, 'svg');
  root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  root.setAttribute('preserveAspectRatio', 'none');
  root.setAttribute('class', cls);
  root.setAttribute('aria-hidden', 'true');
  return root;
}

export function workoutProfileSvg(blocks: CompactBlock[], width = 120, height = 36, cls = 'lib-profile'): SVGSVGElement {
  const root = svg(width, height, cls);
  for (const shape of workoutShapes(blocks, width, height)) {
    const poly = document.createElementNS(SVG, 'polygon');
    poly.setAttribute('points', fmt(shape.points));
    poly.setAttribute('fill', shape.color);
    root.append(poly);
  }
  return root;
}

export function routeProfileSvg(profile: [number, number][], width = 120, height = 36, cls = 'lib-profile'): SVGSVGElement {
  const root = svg(width, height, cls);
  const line = routeLine(profile, width, height);
  if (line.length < 2) return root;
  const area = document.createElementNS(SVG, 'polygon');
  area.setAttribute('points', fmt([[line[0][0], height], ...line, [line[line.length - 1][0], height]]));
  area.setAttribute('class', 'lib-route-area');
  const stroke = document.createElementNS(SVG, 'polyline');
  stroke.setAttribute('points', fmt(line));
  stroke.setAttribute('class', 'lib-route-line');
  root.append(area, stroke);
  return root;
}
