import { hhmmss } from '../core/format';
import { zoneForRatio } from '../core/zones';
import { settings } from '../core/settings';
import { peakRatio, type Segment, type Workout } from '../workout/types';
import type { SessionSnapshot } from '../session/session';

const PADDING = { top: 14, right: 56, bottom: 22, left: 46 };
/** Free-ride window when no workout is loaded, in seconds. */
const FREE_WINDOW = 600;
/** Granularity by which the axis grows when riding past the workout's end. */
const OVERRUN_STEP = 300;

interface Hover { x: number; y: number; }

interface TracePoint { t: number; power: number; hr?: number; }

export class ProfileGraph {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private workout: Workout | undefined;
  private hover: Hover | undefined;
  private lastSnapshot: SessionSnapshot | undefined;
  /** Downsampling the ride costs more than drawing it, and the sample count only
   *  changes once a second — so the bucketed trace is cached between frames. */
  private traceCache: { sampleCount: number; width: number; points: TracePoint[] } | undefined;

  constructor(
    private canvas: HTMLCanvasElement,
    private onSeek: (seconds: number) => void,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement ?? canvas);
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
    canvas.addEventListener('click', (e) => {
      if (!this.workout) return;
      const rect = canvas.getBoundingClientRect();
      const seconds = this.timeAt(e.clientX - rect.left);
      if (seconds !== undefined) this.onSeek(seconds);
    });
  }

  setWorkout(workout: Workout | undefined): void {
    this.workout = workout;
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

  private plot() {
    return {
      x: PADDING.left,
      y: PADDING.top,
      w: Math.max(10, this.width - PADDING.left - PADDING.right),
      h: Math.max(10, this.height - PADDING.top - PADDING.bottom),
    };
  }

  private domain(snapshot: SessionSnapshot): { from: number; to: number } {
    if (this.workout) {
      // Riding on past the workout extends the axis, in five-minute steps so
      // the blocks do not visibly shrink on every frame.
      const overrun = Math.max(0, snapshot.elapsed - this.workout.duration);
      const extra = Math.ceil(overrun / OVERRUN_STEP) * OVERRUN_STEP;
      return { from: 0, to: Math.max(60, this.workout.duration + extra) };
    }
    const to = Math.max(FREE_WINDOW, snapshot.elapsed + 60);
    return { from: Math.max(0, to - FREE_WINDOW), to };
  }

  private timeAt(px: number): number | undefined {
    if (!this.lastSnapshot) return undefined;
    const p = this.plot();
    const { from, to } = this.domain(this.lastSnapshot);
    const ratio = (px - p.x) / p.w;
    if (ratio < 0 || ratio > 1) return undefined;
    return from + ratio * (to - from);
  }

  render(snapshot: SessionSnapshot): void {
    this.lastSnapshot = snapshot;
    const { ctx } = this;
    const p = this.plot();
    const ftp = snapshot.workout?.ftpOverride ?? settings.current.ftp;
    const { from, to } = this.domain(snapshot);
    const span = to - from || 1;

    const peakSamples = snapshot.samples.reduce((m, s) => Math.max(m, s.power), 0) / Math.max(1, ftp);
    const ceiling = Math.max(1.3, this.workout ? peakRatio(this.workout) * 1.12 : 1.5, peakSamples * 1.08);

    const xOf = (t: number) => p.x + ((t - from) / span) * p.w;
    const yOf = (ratio: number) => p.y + p.h - (Math.max(0, ratio) / ceiling) * p.h;

    ctx.clearRect(0, 0, this.width, this.height);

    // --- grid -------------------------------------------------------------
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
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
      ctx.fillText(hhmmss(t), x, p.y + p.h + 11);
    }

    // --- workout blocks ---------------------------------------------------
    if (this.workout) {
      for (const seg of this.workout.segments) {
        this.drawSegment(seg, xOf, yOf, p, snapshot, ftp);
      }
    }

    // --- recorded traces --------------------------------------------------
    this.drawTrace(snapshot, xOf, yOf, p, ftp);

    // --- where the workout ended ------------------------------------------
    if (this.workout && snapshot.elapsed > this.workout.duration) {
      const x = xOf(this.workout.duration);
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
      ctx.font = '10px ui-monospace, Menlo, monospace';
      ctx.fillText('workout done', x + 4, p.y + 8);
    }

    // --- progress cursor --------------------------------------------------
    if (snapshot.elapsed > 0 || snapshot.state !== 'idle') {
      const x = Math.min(p.x + p.w, xOf(snapshot.elapsed));
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
    if (snapshot.targetPower > 0) {
      const y = yOf(snapshot.targetPower / Math.max(1, ftp));
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
      ctx.fillText(`${snapshot.targetPower} W`, p.x + p.w + 8, y);
    }

    if (this.hover) this.drawHover(snapshot, xOf, yOf, p, ftp);
  }

  private drawSegment(
    seg: Segment,
    xOf: (t: number) => number,
    yOf: (r: number) => number,
    p: { x: number; y: number; w: number; h: number },
    snapshot: SessionSnapshot,
    ftp: number,
  ): void {
    const { ctx } = this;
    const x0 = xOf(seg.start);
    const x1 = xOf(seg.start + seg.duration);
    const w = Math.max(1, x1 - x0);
    const isCurrent = seg.index === snapshot.segmentIndex;
    const done = snapshot.elapsed >= seg.start + seg.duration;

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

    if (w > 34) {
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.textAlign = 'center';
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      const label = `${Math.round(((a + b) / 2) * ftp)}`;
      ctx.fillText(label, (x0 + x1) / 2, Math.min(yA, yB) + 9);
    }
  }

  private drawTrace(
    snapshot: SessionSnapshot,
    xOf: (t: number) => number,
    yOf: (r: number) => number,
    p: { x: number; y: number; w: number; h: number },
    ftp: number,
  ): void {
    const { ctx } = this;
    const samples = snapshot.samples;
    if (samples.length < 2) return;

    const width = Math.round(p.w);
    let points = this.traceCache && this.traceCache.sampleCount === samples.length && this.traceCache.width === width
      ? this.traceCache.points
      : undefined;

    if (!points) {
      // Downsample to roughly one point per pixel, keeping the peak in each bucket
      // so spikes survive and long rides stay cheap to draw.
      const bucket = Math.max(1, Math.floor(samples.length / Math.max(1, width)));
      points = [];
      for (let i = 0; i < samples.length; i += bucket) {
        const end = Math.min(samples.length, i + bucket);
        let peak = samples[i];
        let hrSum = 0;
        let hrCount = 0;
        for (let j = i; j < end; j++) {
          const s = samples[j];
          if (s.power > peak.power) peak = s;
          if (s.heartRate) { hrSum += s.heartRate; hrCount++; }
        }
        points.push({
          t: samples[Math.floor((i + end - 1) / 2)].t,
          power: peak.power,
          hr: hrCount ? hrSum / hrCount : undefined,
        });
      }
      this.traceCache = { sampleCount: samples.length, width, points };
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
      const hrMax = settings.current.hrMax || 190;
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

  private drawHover(
    snapshot: SessionSnapshot,
    xOf: (t: number) => number,
    yOf: (r: number) => number,
    p: { x: number; y: number; w: number; h: number },
    ftp: number,
  ): void {
    const { ctx } = this;
    const t = this.timeAt(this.hover!.x);
    if (t === undefined) return;
    const x = xOf(t);

    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, p.y);
    ctx.lineTo(x, p.y + p.h);
    ctx.stroke();

    const seg = this.workout?.segments.find((s) => t >= s.start && t < s.start + s.duration);
    const sample = snapshot.samples.find((s) => Math.abs(s.t - t) < 1.5);
    const lines = [hhmmss(t)];
    if (seg) lines.push(seg.powerStart === undefined ? 'free ride' : `target ${Math.round((seg.powerStart ?? 0) * ftp)} W`);
    if (sample) lines.push(`actual ${sample.power} W${sample.heartRate ? ` · ${sample.heartRate} bpm` : ''}`);

    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
    const height = lines.length * 14 + 10;
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
    lines.forEach((line, i) => ctx.fillText(line, bx + 8, by + 13 + i * 14));
  }
}
