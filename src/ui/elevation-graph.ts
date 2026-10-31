import { gradientColor, type Course, type CoursePosition } from '../activity/course';
import type { SessionSnapshot } from '../session/session';
import { paintBackground } from './profile-graph';

/** The top margin holds the 24 px elevation readout, drawn centred on y 18. */
const PADDING = { top: 36, right: 14, bottom: 21, left: 52 };

export interface Plot { x: number; y: number; w: number; h: number; }

/** The one mapping between a distance along the course and a canvas x, used by
 *  both the drawing code and the hover cursor. Keeping a single pair of
 *  functions is what stops the cursor drifting away from what it points at. */
export function xForDistance(distance: number, plot: Plot, total: number): number {
  return plot.x + (total > 0 ? distance / total : 0) * plot.w;
}

export function distanceForX(x: number, plot: Plot, total: number): number | undefined {
  const ratio = (x - plot.x) / plot.w;
  if (ratio < 0 || ratio > 1) return undefined;
  return ratio * total;
}

export interface Size { width: number; height: number; }

/** The plot area inside a canvas of `size`, below the readout band. */
export function elevationPlot(size: Size): Plot {
  return {
    x: PADDING.left,
    y: PADDING.top,
    w: Math.max(10, size.width - PADDING.left - PADDING.right),
    h: Math.max(10, size.height - PADDING.top - PADDING.bottom),
  };
}

/** How much of one lap of the course has been ridden, 0–1. A full lap or
 *  more is 1: every part of the course was ridden at least once. */
export function riddenFraction(ridden: number, total: number): number {
  if (!(total > 0) || !(ridden > 0)) return 0;
  return Math.min(1, ridden / total);
}

/** Everything one frame of the elevation profile is drawn from. */
export interface ElevationView {
  course: Course | undefined;
  /** the rider now, with the large elevation/gradient readout (ride screen) */
  rider?: Pick<CoursePosition, 'distance' | 'ele' | 'gradient' | 'totalAscent'>;
  /** metres ridden; the course beyond one lap of it is dimmed (summary) */
  ridden?: number;
  /** a line of text in the readout band, in place of the live readout (summary) */
  header?: string;
  hoverDistance?: number;
  /** paint this colour first instead of clearing to transparent (for an image) */
  background?: string;
}

/** Opacity of the course a ride did not reach. */
const UNRIDDEN_ALPHA = 0.3;

/**
 * Draws the elevation profile coloured by gradient, with either the rider's
 * live readout or a summary line above it. The ride screen, the summary and
 * the saved image all draw through this.
 */
export function drawElevationProfile(ctx: CanvasRenderingContext2D, size: Size, view: ElevationView): void {
  paintBackground(ctx, size, view.background);

  if (!view.course || !view.course.hasElevation) {
    ctx.fillStyle = 'rgba(147,161,180,0.55)';
    ctx.font = '14px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(
      view.course ? 'This route has no elevation data' : 'Load a .gpx or .fit route to ride its elevation profile',
      size.width / 2,
      size.height / 2,
    );
    return;
  }

  const course = view.course;
  const p = elevationPlot(size);
  const minEle = course.minEle;
  const span = Math.max(10, course.maxEle - minEle);
  const total = course.totalDistance || 1;
  const xOf = (d: number) => xForDistance(d, p, total);
  const yOf = (e: number) => p.y + p.h - ((e - minEle) / span) * p.h;
  // Everything right of this x was not ridden; without a ridden distance, all of it counts as ridden.
  const riddenX = view.ridden === undefined ? Infinity : xOf(riddenFraction(view.ridden, course.totalDistance) * total);

  // Area fill, one slice per pair of points, tinted by that slice's gradient.
  const base = p.y + p.h;
  for (let i = 1; i < course.points.length; i++) {
    const a = course.points[i - 1];
    const b = course.points[i];
    const x0 = xOf(a.distance);
    const x1 = xOf(b.distance);
    if (x1 - x0 < 0.05 && i < course.points.length - 1) continue;
    ctx.fillStyle = gradientColor((a.gradient + b.gradient) / 2);
    ctx.globalAlpha = (x0 + x1) / 2 > riddenX ? 0.55 * UNRIDDEN_ALPHA : 0.55;
    ctx.beginPath();
    ctx.moveTo(x0, base);
    ctx.lineTo(x0, yOf(a.ele));
    ctx.lineTo(x1, yOf(b.ele));
    ctx.lineTo(x1, base);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const outline = (alpha: number) => {
    ctx.beginPath();
    course.points.forEach((pt, i) => {
      const x = xOf(pt.distance);
      const y = yOf(pt.ele);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = `rgba(231,236,243,${0.85 * alpha})`;
    ctx.lineWidth = 1.3;
    ctx.stroke();
  };
  if (riddenX >= p.x + p.w) {
    outline(1);
  } else {
    // The same line twice, each clipped to its side of the ridden distance.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, riddenX, size.height);
    ctx.clip();
    outline(1);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(riddenX, 0, size.width - riddenX, size.height);
    ctx.clip();
    outline(UNRIDDEN_ALPHA);
    ctx.restore();
  }

  // axes
  ctx.font = '12px ui-monospace, Menlo, monospace';
  ctx.fillStyle = 'rgba(147,161,180,0.7)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${Math.round(course.maxEle)}`, p.x - 6, p.y + 4);
  ctx.fillText(`${Math.round(minEle)}`, p.x - 6, p.y + p.h - 4);

  const step = niceStep(total / 6);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let d = step; d < total; d += step) {
    const x = xOf(d);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, p.y);
    ctx.lineTo(x, base);
    ctx.stroke();
    ctx.fillStyle = 'rgba(147,161,180,0.55)';
    ctx.fillText(`${(d / 1000).toFixed(d % 1000 === 0 ? 0 : 1)}`, x, base + 16);
  }
  ctx.fillStyle = 'rgba(147,161,180,0.55)';
  ctx.fillText('km', p.x + p.w, base + 16);

  if (view.header) {
    ctx.font = '600 20px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(231,236,243,0.95)';
    ctx.fillText(view.header, p.x + 2, 18);
  }
  if (view.rider) drawRider(ctx, view.rider, xOf, yOf, p);
  if (view.hoverDistance !== undefined) drawHover(ctx, course, view.hoverDistance, xOf, yOf, p);
}

function drawRider(
  ctx: CanvasRenderingContext2D,
  rider: NonNullable<ElevationView['rider']>,
  xOf: (d: number) => number,
  yOf: (e: number) => number,
  p: Plot,
): void {
  const { distance, ele, gradient, totalAscent } = rider;
  const x = xOf(distance);
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, p.y);
  ctx.lineTo(x, p.y + p.h);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x, yOf(ele), 4, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();

  // Elevation and gradient, side by side, with the gradient in its own colour.
  // Large and bold: this is the only place the gradient is written, and it is
  // read from the saddle.
  ctx.font = '600 24px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const eleText = `${Math.round(ele)} m`;
  const gradeText = `${gradient >= 0 ? '+' : ''}${gradient.toFixed(1)}%`;
  const ascentText = `↑ ${Math.round(totalAscent)} m`;
  ctx.fillStyle = 'rgba(231,236,243,0.95)';
  ctx.fillText(eleText, p.x + 2, 18);
  const w1 = ctx.measureText(eleText).width;
  ctx.fillStyle = gradientColor(gradient);
  ctx.fillText(gradeText, p.x + 16 + w1, 18);
  const w2 = ctx.measureText(gradeText).width;
  ctx.fillStyle = 'rgba(147,161,180,0.9)';
  ctx.fillText(ascentText, p.x + 30 + w1 + w2, 18);
}

function drawHover(
  ctx: CanvasRenderingContext2D,
  course: Course,
  distance: number,
  xOf: (d: number) => number,
  yOf: (e: number) => number,
  p: Plot,
): void {
  const point = course.at(distance);
  const x = xOf(distance);

  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, p.y);
  ctx.lineTo(x, p.y + p.h);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.beginPath();
  ctx.arc(x, yOf(point.ele), 3.5, 0, Math.PI * 2);
  ctx.fillStyle = gradientColor(point.gradient);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.fill();
  ctx.stroke();

  const text = `${(distance / 1000).toFixed(2)} km · ${Math.round(point.ele)} m · ${point.gradient >= 0 ? '+' : ''}${point.gradient.toFixed(1)}%`;
  ctx.font = '13px ui-monospace, Menlo, monospace';
  const tw = ctx.measureText(text).width + 14;
  const bx = Math.min(p.x + p.w - tw, Math.max(p.x, x + 8));
  ctx.fillStyle = 'rgba(12,16,22,0.94)';
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(bx, p.y + 2, tw, 22, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(236,241,247,0.95)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + 7, p.y + 13);
}

/** The elevation profile that sits under the power graph: coloured by road
 *  gradient, marked with where the rider is now and how much has been climbed.
 *  On the summary it instead shows how much of the route was ridden. */
export class ElevationGraph {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private course: Course | undefined;
  private hoverDistance: number | undefined;
  private lastSnapshot: SessionSnapshot | undefined;
  private finished: { ridden: number; header: string } | undefined;
  private readonly observer: ResizeObserver;

  constructor(
    private canvas: HTMLCanvasElement,
    private onHover: (distance: number | undefined) => void = () => {},
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas.parentElement ?? canvas);
    this.resize();

    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      // Scale from CSS pixels to the canvas coordinate space before converting
      // to a distance, or the cursor drifts ahead of the pointer.
      const x = ((e.clientX - rect.left) / rect.width) * this.width;
      this.hoverDistance = this.distanceAt(x);
      this.onHover(this.hoverDistance);
      this.draw();
    });
    canvas.addEventListener('pointerleave', () => {
      this.hoverDistance = undefined;
      this.onHover(undefined);
      this.draw();
    });
  }

  setCourse(course: Course | undefined): void {
    this.course = course;
    this.hoverDistance = undefined;
    this.draw();
  }

  /** Show a finished ride: how far it went along the course, and a line of text above it. */
  setFinished(ridden: number, header: string): void {
    this.finished = { ridden, header };
    this.draw();
  }

  render(snapshot: SessionSnapshot): void {
    this.lastSnapshot = snapshot;
    this.draw();
  }

  /** Stop following the canvas's size; for a graph whose canvas is being thrown away. */
  dispose(): void {
    this.observer.disconnect();
  }

  private resize(): void {
    const parent = this.canvas.parentElement ?? this.canvas;
    const dpr = window.devicePixelRatio || 1;
    this.width = parent.clientWidth;
    this.height = parent.clientHeight;
    this.canvas.width = Math.max(1, Math.floor(this.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(this.height * dpr));
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  /** Canvas x (in CSS pixels) to metres along the course. */
  private distanceAt(x: number): number | undefined {
    if (!this.course) return undefined;
    return distanceForX(x, elevationPlot({ width: this.width, height: this.height }), this.course.totalDistance);
  }

  private draw(): void {
    const position = this.finished ? undefined : this.lastSnapshot?.coursePosition;
    drawElevationProfile(this.ctx, { width: this.width, height: this.height }, {
      course: this.course,
      ...(position ? { rider: position } : {}),
      ...(this.finished ? { ridden: this.finished.ridden, header: this.finished.header } : {}),
      ...(this.hoverDistance !== undefined ? { hoverDistance: this.hoverDistance } : {}),
    });
  }
}

function niceStep(raw: number): number {
  const candidates = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000];
  for (const c of candidates) if (raw <= c) return c;
  return 100000;
}
