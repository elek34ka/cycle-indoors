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

/** One pixel column of the profile, or one pair of points on a route too
 *  short to fill the plot: where it starts and ends, and what it shows. */
export interface ProfileColumn {
  d0: number;
  d1: number;
  e0: number;
  e1: number;
  /** the road gradient across the column, weighted by distance */
  gradient: number;
  /** lowest and highest elevation inside it, for the outline */
  lo: number;
  hi: number;
}

/**
 * The course bucketed into the plot's pixel columns, through `xForDistance`
 * like everything else drawn on it. Each column starts where the previous one
 * ended, so the area and the outline stay continuous. A route with fewer
 * point pairs than columns gets one entry per pair, exactly as it was drawn
 * point by point. Drawing cost then depends on the plot's width only.
 */
export function binColumns(course: Pick<Course, 'points' | 'totalDistance'>, plot: Plot): ProfileColumn[] {
  const pts = course.points;
  if (pts.length < 2) return [];
  const pair = (i: number): ProfileColumn => {
    const a = pts[i - 1];
    const b = pts[i];
    return {
      d0: a.distance, d1: b.distance, e0: a.ele, e1: b.ele,
      gradient: (a.gradient + b.gradient) / 2, lo: Math.min(a.ele, b.ele), hi: Math.max(a.ele, b.ele),
    };
  };
  const width = Math.max(1, Math.floor(plot.w));
  const columns: ProfileColumn[] = [];
  if (pts.length - 1 <= width) {
    for (let i = 1; i < pts.length; i++) columns.push(pair(i));
    return columns;
  }
  const total = course.totalDistance || 1;
  let current: ProfileColumn | undefined;
  let index = -1;
  let gradientSum = 0;
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const at = Math.max(0, Math.min(width - 1, Math.floor(xForDistance(a.distance, plot, total) - plot.x)));
    if (!current || at !== index) {
      current = pair(i);
      index = at;
      gradientSum = 0;
      run = 0;
      columns.push(current);
    }
    const length = b.distance - a.distance;
    gradientSum += ((a.gradient + b.gradient) / 2) * length;
    run += length;
    current.d1 = b.distance;
    current.e1 = b.ele;
    if (b.ele < current.lo) current.lo = b.ele;
    if (b.ele > current.hi) current.hi = b.ele;
    if (run > 0) current.gradient = gradientSum / run;
  }
  return columns;
}

/** The last binning per course, so a repaint at the same width bins nothing. */
const binned = new WeakMap<object, { width: number; columns: ProfileColumn[] }>();

function columnsFor(course: Course, plot: Plot): ProfileColumn[] {
  const cached = binned.get(course);
  if (cached && cached.width === plot.w) return cached.columns;
  const columns = binColumns(course, plot);
  binned.set(course, { width: plot.w, columns });
  return columns;
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

  // Area fill, one slice per column, tinted by its gradient. Slices of one
  // colour (and one side of the ridden distance) share a path, so a repaint
  // is a handful of fills however many points the route has.
  const base = p.y + p.h;
  const columns = columnsFor(course, p);
  const groups = new Map<string, { color: string; alpha: number; slices: ProfileColumn[] }>();
  for (const c of columns) {
    const color = gradientColor(c.gradient);
    const dim = (xOf(c.d0) + xOf(c.d1)) / 2 > riddenX;
    const key = `${color}${dim ? ' dim' : ''}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { color, alpha: dim ? 0.55 * UNRIDDEN_ALPHA : 0.55, slices: [] });
    group.slices.push(c);
  }
  for (const group of groups.values()) {
    ctx.fillStyle = group.color;
    ctx.globalAlpha = group.alpha;
    ctx.beginPath();
    for (const c of group.slices) {
      const x0 = xOf(c.d0);
      const x1 = xOf(c.d1);
      ctx.moveTo(x0, base);
      ctx.lineTo(x0, yOf(c.e0));
      ctx.lineTo(x1, yOf(c.e1));
      ctx.lineTo(x1, base);
      ctx.closePath();
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  const outline = (alpha: number) => {
    // Through every column; one that hides a bump within its pixel reaches
    // its highest and lowest points at its middle, as a full stroke would.
    ctx.beginPath();
    columns.forEach((c, i) => {
      const x0 = xOf(c.d0);
      if (i === 0) ctx.moveTo(x0, yOf(c.e0)); else ctx.lineTo(x0, yOf(c.e0));
      if (c.hi > Math.max(c.e0, c.e1) || c.lo < Math.min(c.e0, c.e1)) {
        const mid = (x0 + xOf(c.d1)) / 2;
        ctx.lineTo(mid, yOf(c.hi));
        ctx.lineTo(mid, yOf(c.lo));
      }
    });
    const last = columns[columns.length - 1];
    if (last) ctx.lineTo(xOf(last.d1), yOf(last.e1));
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
  /** What the canvas shows now: a tick that would draw the same is skipped.
   *  Every input the drawing reads belongs in `drawKey`. */
  private drawnKey: string | undefined;
  /** false while the screen it is on is not shown: it then paints nothing */
  private active = true;

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
      this.draw(true);
    });
    canvas.addEventListener('pointerleave', () => {
      this.hoverDistance = undefined;
      this.onHover(undefined);
      this.draw(true);
    });
  }

  setCourse(course: Course | undefined): void {
    this.course = course;
    this.hoverDistance = undefined;
    this.draw(true);
  }

  /** Show a finished ride: how far it went along the course, and a line of text above it. */
  setFinished(ridden: number, header: string): void {
    this.finished = { ridden, header };
    this.draw(true);
  }

  render(snapshot: SessionSnapshot): void {
    this.lastSnapshot = snapshot;
    this.draw();
  }

  /** Whether the graph's screen is shown. Shown again, it paints at once. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active) this.draw(true);
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
    this.draw(true);
  }

  /** Canvas x (in CSS pixels) to metres along the course. */
  private distanceAt(x: number): number | undefined {
    if (!this.course) return undefined;
    return distanceForX(x, elevationPlot({ width: this.width, height: this.height }), this.course.totalDistance);
  }

  /**
   * Everything a frame is drawn from, at the resolution it shows: the rider
   * to the pixel and the readout as written. Ticks that leave it unchanged
   * would paint the same picture, so they paint nothing.
   */
  private drawKey(position: CoursePosition | undefined): string {
    const size = `${this.width}x${this.height}`;
    const course = this.course;
    if (!position || !course || !course.hasElevation) return size;
    const p = elevationPlot({ width: this.width, height: this.height });
    const span = Math.max(10, course.maxEle - course.minEle);
    const x = Math.round(xForDistance(position.distance, p, course.totalDistance || 1));
    const y = Math.round(p.y + p.h - ((position.ele - course.minEle) / span) * p.h);
    return `${size}|${x},${y}|${Math.round(position.ele)}|${position.gradient.toFixed(1)}|${Math.round(position.totalAscent)}`;
  }

  /** Paints the profile, unless it would come out the same as now; `force` always paints. */
  private draw(force = false): void {
    const position = this.finished ? undefined : this.lastSnapshot?.coursePosition;
    if (!this.active) return;
    const key = this.drawKey(position);
    if (!force && key === this.drawnKey) return;
    this.drawnKey = key;
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
