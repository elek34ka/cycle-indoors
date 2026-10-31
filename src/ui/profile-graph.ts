import { hhmmss } from '../core/format';
import { zoneForRatio } from '../core/zones';
import { settings } from '../core/settings';
import { peakRatio, targetRatioAt, type Segment, type Workout } from '../workout/types';
import { wattsText } from '../workout/targets';
import type { SessionSnapshot } from '../session/session';
import type { Sample } from '../session/metrics';

const PADDING = { top: 16, right: 66, bottom: 26, left: 54 };
/** Free-ride window when no workout is loaded, in seconds. */
const FREE_WINDOW = 600;
/** Granularity by which the axis grows when riding past the workout's end. */
const OVERRUN_STEP = 300;

interface Hover { x: number; y: number; }

interface TracePoint { t: number; power: number; hr?: number; }

export interface Size { width: number; height: number; }
export interface Plot { x: number; y: number; w: number; h: number; }
/** The span of ride time the graph's x axis covers, in seconds. */
export interface Domain { from: number; to: number; }

/** The plot area inside a canvas of `size`, leaving room for the axes. */
export function graphPlot(size: Size): Plot {
  return {
    x: PADDING.left,
    y: PADDING.top,
    w: Math.max(10, size.width - PADDING.left - PADDING.right),
    h: Math.max(10, size.height - PADDING.top - PADDING.bottom),
  };
}

/**
 * The ride screen's axis: the workout, extended past its end in five-minute
 * steps (so the blocks do not visibly shrink on every frame), or the last ten
 * minutes of a free ride.
 */
export function liveDomain(workout: Pick<Workout, 'duration'> | undefined, elapsed: number): Domain {
  if (workout) {
    const overrun = Math.max(0, elapsed - workout.duration);
    const extra = Math.ceil(overrun / OVERRUN_STEP) * OVERRUN_STEP;
    return { from: 0, to: Math.max(60, workout.duration + extra) };
  }
  const to = Math.max(FREE_WINDOW, elapsed + 60);
  return { from: Math.max(0, to - FREE_WINDOW), to };
}

/** The summary's axis: the whole ride from its start, and the whole workout
 *  even when the ride stopped short of its end. */
export function wholeRideDomain(workout: Pick<Workout, 'duration'> | undefined, duration: number): Domain {
  return { from: 0, to: Math.max(60, workout?.duration ?? 0, duration) };
}

/** The ride screen's extras: the block being ridden, the cursor and the target line. */
export interface LiveMarks {
  segmentIndex: number;
  targetPower: number;
  cursor: boolean;
}

/** Everything one frame of the workout graph is drawn from. */
export interface GraphView {
  workout: Workout | undefined;
  samples: readonly Sample[];
  /** seconds ridden; blocks that end before it are drawn as done */
  elapsed: number;
  ftp: number;
  hrMax: number;
  /** trailing-average window for the traces, in seconds */
  smoothWindow: number;
  domain: Domain;
  live?: LiveMarks;
  /** pointer position in CSS pixels, for the hover readout */
  hover?: Hover;
  /** paint this colour first instead of clearing to transparent (for an image) */
  background?: string;
}

/** The downsampled trace, kept between frames by whoever owns the canvas. */
export interface TraceCache { sampleCount: number; width: number; window: number; points: TracePoint[]; }

/** The ride time under canvas x `px`, or undefined outside the plot. */
export function timeAtX(px: number, plot: Plot, domain: Domain): number | undefined {
  const ratio = (px - plot.x) / plot.w;
  if (ratio < 0 || ratio > 1) return undefined;
  return domain.from + ratio * (domain.to - domain.from);
}

/**
 * Trailing average of power and heart rate over `window` seconds of ride time,
 * the same smoothing the tiles show, so the trace does not jitter second to
 * second. Missing or zero heart rate is left out rather than averaged in as 0.
 * A window of 0 returns the samples as they are.
 */
export function smoothSamples(samples: readonly Sample[], window: number): TracePoint[] {
  let start = 0;
  let powerSum = 0;
  let hrSum = 0;
  let hrCount = 0;
  return samples.map((s, i) => {
    if (window <= 0) return { t: s.t, power: s.power, hr: s.heartRate || undefined };
    powerSum += s.power;
    if (s.heartRate) { hrSum += s.heartRate; hrCount++; }
    while (samples[start].t <= s.t - window) {
      powerSum -= samples[start].power;
      if (samples[start].heartRate) { hrSum -= samples[start].heartRate!; hrCount--; }
      start++;
    }
    return { t: s.t, power: powerSum / (i - start + 1), hr: hrCount ? hrSum / hrCount : undefined };
  });
}

/** A block label is drawn only with 4 px clear on each side; a block too narrow
 *  for it gets no label rather than a shortened, misleading one. */
export function labelFits(textWidth: number, blockWidth: number): boolean {
  return textWidth + 8 <= blockWidth;
}

/**
 * Where to draw a block's label (its baseline-middle y), centred on a block
 * whose top edge runs from (x0, yA) to (x1, yB). On a ramp the edge is lower
 * (larger y) at one end of the label than the other; placing the label by the
 * lower one keeps all of it on the block's colour. Undefined when the label
 * would run past `bottom`, the foot of the graph.
 */
export function blockLabelY(
  x0: number, x1: number, yA: number, yB: number, textWidth: number, bottom: number,
): number | undefined {
  const edgeAt = (x: number) => (x1 > x0 ? yA + ((yB - yA) * (x - x0)) / (x1 - x0) : yA);
  const centre = (x0 + x1) / 2;
  const y = Math.max(edgeAt(centre - textWidth / 2), edgeAt(centre + textWidth / 2)) + 11;
  // 12 px text, baseline-middle: it reaches 7 px below y
  return y + 7 <= bottom ? y : undefined;
}

/** The hover readout: time, the target at exactly that moment (and the range on
 *  a ramp), the block's whole duration, then what was actually ridden there. */
export function hoverLines(
  seg: Segment | undefined,
  t: number,
  sample: Pick<Sample, 'power' | 'heartRate'> | undefined,
  ftp: number,
): string[] {
  const lines = [hhmmss(t)];
  if (seg) {
    const ratio = targetRatioAt(seg, t);
    if (ratio === undefined) lines.push('free ride');
    else {
      lines.push(`target ${Math.round(ratio * ftp)} W`);
      const range = wattsText(seg, ftp);
      if (range?.includes('–')) lines.push(`range ${range}`);
    }
    lines.push(`duration ${hhmmss(seg.duration)}`);
  }
  if (sample) lines.push(`actual ${sample.power} W${sample.heartRate ? ` · ${sample.heartRate} bpm` : ''}`);
  return lines;
}

/**
 * Draws one frame of the workout graph: grid, blocks coloured by zone, the
 * ridden power and heart rate, where the workout ended, and — when `live` is
 * given — the cursor and target line. The ride screen, the summary and the
 * saved image all draw through this, so they cannot drift apart.
 */
export function drawWorkoutGraph(
  ctx: CanvasRenderingContext2D,
  size: Size,
  view: GraphView,
  cache: { current?: TraceCache } = {},
): void {
  const p = graphPlot(size);
  const { ftp, workout } = view;
  const { from, to } = view.domain;
  const span = to - from || 1;

  const peakSamples = view.samples.reduce((m, s) => Math.max(m, s.power), 0) / Math.max(1, ftp);
  const ceiling = Math.max(1.3, workout ? peakRatio(workout) * 1.12 : 1.5, peakSamples * 1.08);

  const xOf = (t: number) => p.x + ((t - from) / span) * p.w;
  const yOf = (ratio: number) => p.y + p.h - (Math.max(0, ratio) / ceiling) * p.h;

  paintBackground(ctx, size, view.background);

  // --- grid -------------------------------------------------------------
  ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  for (let ratio = 0.5; ratio < ceiling; ratio += 0.5) {
    const y = yOf(ratio);
    ctx.strokeStyle = ratio === 1 ? 'rgba(240,195,60,0.35)' : 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.x, y + 0.5);
    ctx.lineTo(p.x + p.w, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = ratio === 1 ? 'rgba(240,195,60,0.8)' : 'rgba(255,255,255,0.32)';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(ratio * ftp)}`, p.x - 8, y);
  }

  // time ticks every 5 or 10 minutes depending on length
  const tickStep = span > 10800 ? 1800 : span > 3600 ? 600 : span > 1200 ? 300 : 60;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  for (let t = Math.ceil(from / tickStep) * tickStep; t <= to; t += tickStep) {
    const x = xOf(t);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.moveTo(x + 0.5, p.y);
    ctx.lineTo(x + 0.5, p.y + p.h);
    ctx.stroke();
    ctx.fillText(hhmmss(t), x, p.y + p.h + 14);
  }

  // --- workout blocks ---------------------------------------------------
  if (workout) {
    for (const seg of workout.segments) drawSegment(ctx, seg, xOf, yOf, p, view);
  }

  // --- recorded traces --------------------------------------------------
  drawTrace(ctx, view, xOf, yOf, p, cache);

  // --- where the workout ended ------------------------------------------
  if (workout && view.elapsed > workout.duration) {
    const x = xOf(workout.duration);
    ctx.strokeStyle = 'rgba(63,192,122,0.6)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, p.y);
    ctx.lineTo(x, p.y + p.h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(63,192,122,0.85)';
    ctx.textAlign = 'left';
    ctx.font = '12px ui-monospace, Menlo, monospace';
    ctx.fillText('workout done', x + 4, p.y + 10);
  }

  // --- progress cursor --------------------------------------------------
  if (view.live?.cursor) {
    const x = Math.min(p.x + p.w, xOf(view.elapsed));
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, p.y);
    ctx.lineTo(x, p.y + p.h);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // --- target readout on the right --------------------------------------
  if (view.live && view.live.targetPower > 0) {
    const y = yOf(view.live.targetPower / Math.max(1, ftp));
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.x, y);
    ctx.lineTo(p.x + p.w + 4, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.textAlign = 'left';
    ctx.fillText(`${view.live.targetPower} W`, p.x + p.w + 8, y);
  }

  if (view.hover) drawHover(ctx, view, view.hover, xOf, yOf, p);
}

/** Clear the canvas, or fill it when it is becoming an image and must not be transparent. */
export function paintBackground(ctx: CanvasRenderingContext2D, size: Size, background: string | undefined): void {
  if (background === undefined) {
    ctx.clearRect(0, 0, size.width, size.height);
    return;
  }
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size.width, size.height);
}

function drawSegment(
  ctx: CanvasRenderingContext2D,
  seg: Segment,
  xOf: (t: number) => number,
  yOf: (r: number) => number,
  p: Plot,
  view: GraphView,
): void {
  const { ftp } = view;
  const x0 = xOf(seg.start);
  const x1 = xOf(seg.start + seg.duration);
  const w = Math.max(1, x1 - x0);
  const isCurrent = seg.index === view.live?.segmentIndex;
  const done = view.elapsed >= seg.start + seg.duration;

  if (seg.powerStart === undefined) {
    // free ride: a flat hatched band, so it reads as "no target"
    const y = yOf(0.55);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y, w, p.y + p.h - y);
    ctx.clip();
    ctx.fillStyle = 'rgba(120,134,148,0.18)';
    ctx.fillRect(x0, y, w, p.y + p.h - y);
    ctx.strokeStyle = 'rgba(160,174,188,0.3)';
    ctx.lineWidth = 1;
    for (let s = -p.h; s < w + p.h; s += 8) {
      ctx.beginPath();
      ctx.moveTo(x0 + s, p.y + p.h);
      ctx.lineTo(x0 + s + p.h, y);
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = isCurrent ? 'rgba(255,255,255,0.8)' : 'rgba(160,174,188,0.45)';
    ctx.lineWidth = isCurrent ? 2 : 1;
    ctx.strokeRect(x0 + 0.5, y + 0.5, w - 1, p.y + p.h - y - 1);
    return;
  }

  const a = seg.powerStart;
  const b = seg.powerEnd ?? seg.powerStart;
  const zone = zoneForRatio((a + b) / 2);
  const yA = yOf(a);
  const yB = yOf(b);

  ctx.beginPath();
  ctx.moveTo(x0, p.y + p.h);
  ctx.lineTo(x0, yA);
  ctx.lineTo(x1, yB);
  ctx.lineTo(x1, p.y + p.h);
  ctx.closePath();
  ctx.fillStyle = zone.color;
  ctx.globalAlpha = done ? 0.85 : isCurrent ? 0.95 : 0.5;
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.strokeStyle = isCurrent ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.35)';
  ctx.lineWidth = isCurrent ? 2 : 1;
  ctx.stroke();

  const label = wattsText(seg, ftp);
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
  const textWidth = label ? ctx.measureText(label).width : 0;
  const y = label && labelFits(textWidth, w) ? blockLabelY(x0, x1, yA, yB, textWidth, p.y + p.h) : undefined;
  if (label && y !== undefined) {
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.textAlign = 'center';
    ctx.fillText(label, (x0 + x1) / 2, y);
  }
}

function drawTrace(
  ctx: CanvasRenderingContext2D,
  view: GraphView,
  xOf: (t: number) => number,
  yOf: (r: number) => number,
  p: Plot,
  cache: { current?: TraceCache },
): void {
  const { samples, ftp } = view;
  if (samples.length < 2) return;

  const width = Math.round(p.w);
  const window = view.smoothWindow;
  const cached = cache.current;
  let points = cached && cached.sampleCount === samples.length && cached.width === width && cached.window === window
    ? cached.points
    : undefined;

  if (!points) {
    const smoothed = smoothSamples(samples, window);
    // Downsample to roughly one point per pixel, keeping the peak in each bucket
    // so efforts survive and long rides stay cheap to draw.
    const bucket = Math.max(1, Math.floor(smoothed.length / Math.max(1, width)));
    points = [];
    for (let i = 0; i < smoothed.length; i += bucket) {
      const end = Math.min(smoothed.length, i + bucket);
      let peak = smoothed[i].power;
      let hrSum = 0;
      let hrCount = 0;
      for (let j = i; j < end; j++) {
        const s = smoothed[j];
        if (s.power > peak) peak = s.power;
        if (s.hr) { hrSum += s.hr; hrCount++; }
      }
      points.push({
        t: smoothed[Math.floor((i + end - 1) / 2)].t,
        power: peak,
        hr: hrCount ? hrSum / hrCount : undefined,
      });
    }
    cache.current = { sampleCount: samples.length, width, window, points };
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(p.x, p.y, p.w, p.h);
  ctx.clip();

  ctx.beginPath();
  points.forEach((pt, i) => {
    const x = xOf(pt.t);
    const y = yOf(pt.power / Math.max(1, ftp));
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  const hrPoints = points.filter((pt) => pt.hr !== undefined);
  if (hrPoints.length > 1) {
    const hrMax = view.hrMax || 190;
    ctx.beginPath();
    hrPoints.forEach((pt, i) => {
      const x = xOf(pt.t);
      // HR shares the panel: map 40%-100% of max HR onto the full height
      const norm = ((pt.hr! / hrMax) - 0.4) / 0.6;
      const y = p.y + p.h - Math.max(0, Math.min(1, norm)) * p.h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(228,86,60,0.8)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  ctx.restore();
}

/** The block and the recorded second under ride time `t`: what the hover readout describes. */
export function hoverTarget(view: Pick<GraphView, 'workout' | 'samples'>, t: number): {
  seg: Segment | undefined;
  sample: Sample | undefined;
} {
  return {
    seg: view.workout?.segments.find((s) => t >= s.start && t < s.start + s.duration),
    sample: view.samples.find((s) => Math.abs(s.t - t) < 1.5),
  };
}

function drawHover(
  ctx: CanvasRenderingContext2D,
  view: GraphView,
  hover: Hover,
  xOf: (t: number) => number,
  yOf: (r: number) => number,
  p: Plot,
): void {
  const t = timeAtX(hover.x, p, view.domain);
  if (t === undefined) return;
  const x = xOf(t);

  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, p.y);
  ctx.lineTo(x, p.y + p.h);
  ctx.stroke();

  const { seg, sample } = hoverTarget(view, t);
  const lines = hoverLines(seg, t, sample, view.ftp);

  ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace';
  const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
  const height = lines.length * 17 + 10;
  const bx = Math.min(p.x + p.w - width, Math.max(p.x, x + 10));
  const by = Math.max(p.y, Math.min(p.y + p.h - height, yOf(1) - height / 2));

  ctx.fillStyle = 'rgba(12,16,22,0.92)';
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.beginPath();
  ctx.roundRect(bx, by, width, height, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(236,241,247,0.95)';
  ctx.textAlign = 'left';
  lines.forEach((line, i) => ctx.fillText(line, bx + 8, by + 15 + i * 17));
}

export interface ProfileGraphOptions {
  /** 'whole' draws the finished ride from its start with no cursor or target line (the summary) */
  mode?: 'live' | 'whole';
}

/** The workout graph on an on-screen canvas: sizing, hover and the trace cache. */
export class ProfileGraph {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private workout: Workout | undefined;
  private hover: Hover | undefined;
  private lastSnapshot: SessionSnapshot | undefined;
  private readonly mode: 'live' | 'whole';
  private readonly observer: ResizeObserver;
  /** Downsampling the ride costs more than drawing it, and the sample count only
   *  changes once a second — so the bucketed trace is cached between frames. */
  private traceCache: { current?: TraceCache } = {};

  constructor(private canvas: HTMLCanvasElement, options: ProfileGraphOptions = {}) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
    this.mode = options.mode ?? 'live';

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas.parentElement ?? canvas);
    this.resize();

    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.hover = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (this.lastSnapshot) this.render(this.lastSnapshot);
    });
    canvas.addEventListener('pointerleave', () => {
      this.hover = undefined;
      if (this.lastSnapshot) this.render(this.lastSnapshot);
    });
  }

  setWorkout(workout: Workout | undefined): void {
    this.workout = workout;
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
    if (this.lastSnapshot) this.render(this.lastSnapshot);
  }

  /** What the graph would draw for `snapshot` now, hover included. */
  view(snapshot: SessionSnapshot): GraphView {
    const whole = this.mode === 'whole';
    const lastT = snapshot.samples.length ? snapshot.samples[snapshot.samples.length - 1].t : 0;
    return {
      workout: this.workout,
      samples: snapshot.samples,
      elapsed: snapshot.elapsed,
      ftp: snapshot.workout?.ftpOverride ?? settings.current.ftp,
      hrMax: settings.current.hrMax,
      smoothWindow: settings.current.smoothPowerSeconds,
      domain: whole
        ? wholeRideDomain(this.workout, Math.max(snapshot.elapsed, lastT))
        : liveDomain(this.workout, snapshot.elapsed),
      ...(whole ? {} : {
        live: {
          segmentIndex: snapshot.segmentIndex,
          targetPower: snapshot.targetPower,
          cursor: snapshot.elapsed > 0 || snapshot.state !== 'idle',
        },
      }),
      ...(this.hover ? { hover: this.hover } : {}),
    };
  }

  render(snapshot: SessionSnapshot): void {
    this.lastSnapshot = snapshot;
    drawWorkoutGraph(this.ctx, { width: this.width, height: this.height }, this.view(snapshot), this.traceCache);
  }
}
