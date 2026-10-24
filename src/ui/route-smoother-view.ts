import { courseStore } from '../activity/course-store';
import { gradientColor } from '../activity/course';
import { downloadBytes } from '../activity/fit-export';
import { parseGpx } from '../activity/gpx';
import { buildGpx, smoothedTrackPoints } from '../activity/gpx-export';
import { gradientRuns, positionAt, type LatLon } from '../activity/route-geometry';
import {
  PARAM_SPECS, PRESETS, PRESET_LABELS, gradientAt, normaliseParams, routeDistances, routeProblem, smoothProfile,
  validateParams, valueAt, type ProfileStats, type SmoothedProfile, type SmoothingParams, type SmoothingPreset,
} from '../activity/smoothing';
import type { ActivityTrack } from '../activity/types';
import { settings } from '../core/settings';
import { loadFile } from '../loaders';
import { session } from '../session/session';
import { distanceForX, xForDistance, type Plot } from './elevation-graph';
import { clear, el, qs, setText, toast } from './dom';
import { RoutePreviewMap } from './route-preview-map';

type Stored = SmoothingParams & { preset: SmoothingPreset };

const PADDING = { top: 12, right: 14, bottom: 22, left: 52 };
/** The gradient chart's y-range covers both traces, but raw GPS can produce a
 *  ±80% blip that would squash everything else flat; nothing ridable is
 *  steeper than the parameters allow, so the range stops at ±30%. */
const GRADIENT_AXIS_LIMIT = 30;
const ORIGINAL_COLOR = 'rgba(147,161,180,0.85)';
const SMOOTHED_COLOR = '#4da3ff';

/** Smallest and largest of several series, without spreading a 40 000-sample
 *  route into one call's arguments. */
function extent(...series: number[][]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const values of series) for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}

const signed = (v: number, digits = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;

/** One canvas, sized to its parent like the ride view's graphs. */
class ChartCanvas {
  readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;

  constructor(readonly canvas: HTMLCanvasElement, private onResize: () => void) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement ?? canvas);
    this.resize();
  }

  resize(): void {
    const parent = this.canvas.parentElement ?? this.canvas;
    const dpr = window.devicePixelRatio || 1;
    this.width = parent.clientWidth;
    this.height = parent.clientHeight;
    this.canvas.width = Math.max(1, Math.floor(this.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(this.height * dpr));
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.onResize();
  }

  plot(): Plot {
    return {
      x: PADDING.left,
      y: PADDING.top,
      w: Math.max(10, this.width - PADDING.left - PADDING.right),
      h: Math.max(10, this.height - PADDING.top - PADDING.bottom),
    };
  }

  /** Pointer position in canvas coordinates, then metres along the route. */
  distanceAt(clientX: number, total: number): number | undefined {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * this.width;
    return distanceForX(x, this.plot(), total);
  }
}

/**
 * Settings → Route smoother. Loads a route of its own, shows what smoothing
 * does to it against the original, and hands the result on as a GPX download
 * or as the ride's course. The ride's course is not touched until the rider
 * asks for that.
 */
export class RouteSmootherView {
  private track: ActivityTrack | undefined;
  private fileBase = 'route';
  private profile: SmoothedProfile | undefined;
  private params: Stored = { ...settings.current.routeSmoothing };
  private hoverDistance: number | undefined;
  private pending = 0;
  /** the track's located points and their distances, as the map and the GPX use them */
  private points: LatLon[] = [];
  private distances: number[] = [];
  /** the next recompute is for a newly loaded route, so the map frames it */
  private newRoute = false;

  private readonly presetSelect: HTMLSelectElement;
  private readonly inputs = new Map<keyof SmoothingParams, HTMLInputElement>();
  private readonly source: HTMLElement;
  private readonly body: HTMLElement;
  private readonly warning: HTMLElement;
  private readonly table: HTMLElement;
  private readonly readout: HTMLElement;
  private readonly downloadButton: HTMLButtonElement;
  private readonly rideButton: HTMLButtonElement;
  private readonly rideHint: HTMLElement;
  private readonly elevationChart: ChartCanvas;
  private readonly gradientChart: ChartCanvas;
  private readonly map: RoutePreviewMap;

  constructor(host: HTMLElement = qs('#smoother-panel')) {
    const picker = el('input', { type: 'file', attrs: { accept: '.gpx,.fit' } }) as HTMLInputElement;
    picker.style.display = 'none';
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      if (file) void this.load(file);
      picker.value = '';
    });

    const drop = el('div', { class: 'drop-zone', id: 'smoother-drop' }, [
      el('strong', { text: 'Drop a .gpx or .fit route' }),
      el('span', { text: 'its own copy: the ride’s route is not changed' }),
    ]);
    const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
    drop.addEventListener('dragover', (e) => { stop(e); drop.classList.add('over'); });
    drop.addEventListener('dragleave', (e) => { stop(e); drop.classList.remove('over'); });
    drop.addEventListener('drop', (e) => {
      stop(e);
      drop.classList.remove('over');
      const file = (e as DragEvent).dataTransfer?.files?.[0];
      if (file) void this.load(file);
    });

    this.presetSelect = el('select', { class: 'select', id: 'smoother-preset' }) as HTMLSelectElement;
    for (const preset of ['light', 'medium', 'strong', 'custom'] as SmoothingPreset[]) {
      this.presetSelect.append(el('option', { value: preset, text: PRESET_LABELS[preset] }));
    }
    this.presetSelect.addEventListener('change', () => this.choosePreset(this.presetSelect.value as SmoothingPreset));

    const advanced = el('div', { class: 'field-grid' });
    for (const spec of PARAM_SPECS) {
      const input = el('input', {
        type: 'number', min: String(spec.min), max: String(spec.max), step: String(spec.step),
        dataset: { param: spec.key },
      }) as HTMLInputElement;
      input.addEventListener('change', () => this.editParam(spec.key, Number(input.value)));
      this.inputs.set(spec.key, input);
      advanced.append(el('div', { class: 'field' }, [
        el('label', { text: spec.label }),
        input,
        el('div', { class: 'suffix', text: spec.suffix }),
      ]));
    }

    this.source = el('div', { class: 'smoother-source', id: 'smoother-source' });
    this.warning = el('p', { class: 'hint hint-warn', id: 'smoother-warning' });
    this.warning.hidden = true;
    this.table = el('div', { class: 'smoother-table', id: 'smoother-table' });
    this.readout = el('div', { class: 'smoother-readout', id: 'smoother-readout' });

    const elevationCanvas = el('canvas', { id: 'smoother-elevation' }) as HTMLCanvasElement;
    const gradientCanvas = el('canvas', { id: 'smoother-gradient' }) as HTMLCanvasElement;
    const elevationBox = el('div', { class: 'smoother-chart' }, [elevationCanvas]);
    const gradientBox = el('div', { class: 'smoother-chart' }, [gradientCanvas]);
    const mapBox = el('div', { class: 'smoother-map', id: 'smoother-map' });

    this.downloadButton = el('button', {
      class: 'btn', id: 'smoother-download', text: 'Download smoothed .gpx', disabled: true,
      on: { click: () => this.download() },
    }) as HTMLButtonElement;
    this.rideButton = el('button', {
      class: 'btn btn-primary', id: 'smoother-ride', text: 'Ride this route', disabled: true,
      on: { click: () => this.ride() },
    }) as HTMLButtonElement;
    this.rideHint = el('span', { class: 'suffix', id: 'smoother-ride-hint' });

    this.body = el('div', { class: 'smoother-body' }, [
      this.source,
      el('div', { class: 'smoother-legend' }, [
        el('span', { class: 'legend-original', text: 'original' }),
        el('span', { class: 'legend-smoothed', text: 'smoothed' }),
      ]),
      el('div', { class: 'smoother-chart-title', text: 'Elevation' }),
      elevationBox,
      el('div', { class: 'smoother-chart-title', text: 'Gradient' }),
      gradientBox,
      el('div', { class: 'smoother-chart-title', text: 'Map' }),
      mapBox,
      this.readout,
      this.warning,
      this.table,
    ]);
    this.body.hidden = true;

    clear(host);
    host.append(
      el('h2', { text: 'Route smoother' }),
      el('p', {
        class: 'hint',
        text: 'Takes the jitter and the sudden ramps out of a route’s elevation, so the gradient a trainer '
          + 'follows changes gently. Load a route, compare the result with the original, then download it '
          + 'as a .gpx or ride it.',
      }),
      el('div', { class: 'smoother-load' }, [
        drop,
        el('button', { class: 'btn btn-small', text: 'Load file', on: { click: () => picker.click() } }),
      ]),
      el('div', { class: 'field-grid' }, [
        el('div', { class: 'field' }, [
          el('label', { text: 'Smoothing' }),
          this.presetSelect,
          el('div', { class: 'suffix', text: 'Light keeps more of the road’s bite; Strong rides like a gentle ramp' }),
        ]),
      ]),
      el('details', { class: 'sim-disclosure smoother-advanced' }, [el('summary', { text: 'Advanced' }), advanced]),
      this.body,
      el('div', { class: 'summary-actions' }, [this.rideHint, this.downloadButton, this.rideButton]),
    );
    document.body.append(picker);

    this.elevationChart = new ChartCanvas(elevationCanvas, () => this.draw());
    this.gradientChart = new ChartCanvas(gradientCanvas, () => this.draw());
    for (const chart of [this.elevationChart, this.gradientChart]) {
      chart.canvas.addEventListener('pointermove', (e) => {
        if (!this.profile) return;
        this.setHover(chart.distanceAt(e.clientX, this.total()));
      });
      chart.canvas.addEventListener('pointerleave', () => this.setHover(undefined));
    }

    // Built now, but Leaflet is only fetched once a route is loaded.
    this.map = new RoutePreviewMap(mapBox);
    this.map.onHover = (distance) => this.setHover(distance);

    this.showParams();
    session.on('state', () => this.refreshButtons());
    // "Reset to defaults" on the rider profile resets these too.
    settings.on('change', (s) => {
      if (JSON.stringify(s.routeSmoothing) === JSON.stringify(this.params)) return;
      this.params = { ...s.routeSmoothing };
      this.showParams();
      this.schedule();
    });
    this.refreshButtons();
  }

  get current(): SmoothedProfile | undefined { return this.profile; }

  get previewMap(): RoutePreviewMap { return this.map; }

  async load(file: File): Promise<void> {
    let track: ActivityTrack | undefined;
    try {
      track = (await loadFile(file, { ftp: settings.current.ftp })).track;
    } catch (err) {
      toast((err as Error).message, 'error');
      return;
    }
    if (!track) {
      toast(`"${file.name}" is not a route: load a .gpx track or a .fit ride with GPS records`, 'error');
      return;
    }
    const problem = routeProblem(track);
    if (problem) {
      toast(problem, 'error');
      return;
    }
    this.track = track;
    this.points = track.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    this.distances = routeDistances(this.points);
    this.newRoute = true;
    this.fileBase = file.name.replace(/\.[^.]+$/, '') || 'route';
    this.hoverDistance = undefined;
    this.recompute();
  }

  // ---- parameters ----------------------------------------------------------

  private showParams(): void {
    this.presetSelect.value = this.params.preset;
    for (const [key, input] of this.inputs) input.value = String(this.params[key]);
  }

  private save(): void {
    settings.patch({ routeSmoothing: { ...this.params } });
  }

  private choosePreset(preset: SmoothingPreset): void {
    // Custom keeps whatever is in the fields; a named preset replaces them.
    this.params = preset === 'custom' ? { ...this.params, preset } : { ...PRESETS[preset], preset };
    this.showParams();
    this.save();
    this.schedule();
  }

  private editParam(key: keyof SmoothingParams, value: number): void {
    const { preset: _preset, ...current } = this.params;
    const candidate: SmoothingParams = { ...current, [key]: value };
    const problem = validateParams(candidate);
    if (problem) {
      toast(problem, 'error');
      this.showParams();
      return;
    }
    this.params = { ...normaliseParams(candidate), preset: 'custom' };
    this.showParams();
    this.save();
    this.schedule();
  }

  // ---- computing -----------------------------------------------------------

  /** Coalesce a burst of edits into one recompute per frame. */
  private schedule(): void {
    if (!this.track || this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.recompute();
    });
  }

  private recompute(): void {
    if (!this.track) return;
    const { preset: _preset, ...params } = this.params;
    this.profile = smoothProfile(this.track, params);
    this.body.hidden = false;
    const km = (this.total() / 1000).toFixed(2);
    setText(this.source, `${this.track.name} · ${km} km · ${this.track.points.length} points`);
    this.renderWarning();
    this.renderTable();
    this.renderReadout();
    this.refreshButtons();
    this.draw();
    const runs = gradientRuns(this.points, this.distances, this.profile);
    if (this.newRoute) {
      this.newRoute = false;
      void this.map.setRoute(this.points, this.distances, runs);
    } else {
      this.map.setColours(runs);
    }
  }

  private total(): number {
    const d = this.profile?.distances;
    return d ? d[d.length - 1] : 0;
  }

  private renderWarning(): void {
    const short = this.profile?.anchorShortfall;
    this.warning.hidden = short === undefined;
    if (short === undefined) return;
    setText(this.warning, `These gradient limits cannot reach the finish height: the smoothed route ends `
      + `${Math.abs(short).toFixed(1)} m ${short > 0 ? 'too low' : 'too high'}. Allow steeper gradients to close the gap.`);
  }

  private renderTable(): void {
    const p = this.profile;
    if (!p) return;
    const rows: [string, (s: ProfileStats) => string][] = [
      ['Ascent', (s) => `${Math.round(s.ascent)} m`],
      ['Descent', (s) => `${Math.round(s.descent)} m`],
      ['Steepest climb', (s) => `${signed(s.maxGradient)}%`],
      ['Steepest descent', (s) => `${signed(s.minGradient)}%`],
      ['Largest change', (s) => `${s.maxChange.toFixed(1)} % / 10 m`],
      ['Start shift', (s) => `${signed(s.startShift)} m`],
      ['Finish shift', (s) => `${signed(s.finishShift)} m`],
    ];
    clear(this.table);
    this.table.append(
      el('span', { class: 'th' }), el('span', { class: 'th', text: 'Original' }), el('span', { class: 'th', text: 'Smoothed' }),
    );
    for (const [label, fmt] of rows) {
      this.table.append(
        el('span', { class: 'row-label', text: label }),
        el('span', { dataset: { col: 'original' }, text: fmt(p.stats.original) }),
        el('span', { dataset: { col: 'smoothed' }, text: fmt(p.stats.smoothed) }),
      );
    }
  }

  private setHover(distance: number | undefined): void {
    this.hoverDistance = distance;
    this.map.setHover(distance === undefined ? undefined : positionAt(this.points, this.distances, distance));
    this.renderReadout();
    this.draw();
  }

  private renderReadout(): void {
    const p = this.profile;
    const d = this.hoverDistance;
    if (!p || d === undefined) {
      setText(this.readout, 'Hover a chart to compare the two at any point.');
      return;
    }
    const at = (series: number[], grade: number[]) =>
      `${Math.round(valueAt(p, series, d))} m, ${signed(gradientAt(grade, p.step, d))}%`;
    setText(this.readout, `${(d / 1000).toFixed(2)} km · original ${at(p.original, p.originalGradient)}`
      + ` · smoothed ${at(p.smoothed, p.smoothedGradient)}`);
  }

  // ---- actions -------------------------------------------------------------

  private rideBlocked(): boolean {
    const state = session.snapshot.state;
    return state === 'running' || state === 'paused';
  }

  private refreshButtons(): void {
    const ready = this.profile !== undefined;
    const blocked = this.rideBlocked();
    this.downloadButton.disabled = !ready;
    this.rideButton.disabled = !ready || blocked;
    setText(this.rideHint, ready && blocked ? 'The course cannot change mid-ride: finish the ride first' : '');
  }

  private smoothedGpx(name: string): string | undefined {
    if (!this.track || !this.profile) return undefined;
    return buildGpx(name, smoothedTrackPoints(this.track, this.profile));
  }

  private download(): void {
    const xml = this.smoothedGpx(this.track?.name ?? 'Route');
    if (!xml) return;
    downloadBytes(new TextEncoder().encode(xml), `${this.fileBase}-smoothed.gpx`, 'application/gpx+xml');
    toast('Smoothed route downloaded.');
  }

  /** Load it as the course exactly as if the downloaded file had been loaded. */
  private ride(): void {
    if (this.rideBlocked() || !this.track) return;
    const name = `${this.track.name} (smoothed)`;
    const xml = this.smoothedGpx(name);
    if (!xml) return;
    const course = courseStore.load(parseGpx(xml, name));
    if (course) {
      toast(`Route "${course.name}" is now the ride’s course — ${(course.totalDistance / 1000).toFixed(1)} km, `
        + `${Math.round(course.totalAscent)} m up`);
    }
  }

  // ---- drawing -------------------------------------------------------------

  private draw(): void {
    // The constructor sizes the first canvas before the second exists.
    if (!this.elevationChart || !this.gradientChart) return;
    this.drawElevation();
    this.drawGradient();
  }

  private drawElevation(): void {
    const chart = this.elevationChart;
    const { ctx } = chart;
    ctx.clearRect(0, 0, chart.width, chart.height);
    const p = this.profile;
    if (!p) return;
    const plot = chart.plot();
    const total = this.total() || 1;
    const [lo, hi] = extent(p.original, p.smoothed);
    const span = Math.max(10, hi - lo);
    const xOf = (d: number) => xForDistance(d, plot, total);
    const yOf = (e: number) => plot.y + plot.h - ((e - lo) / span) * plot.h;
    const base = plot.y + plot.h;

    // The smoothed profile's area, tinted by its own gradient.
    ctx.globalAlpha = 0.45;
    for (let i = 0; i + 1 < p.distances.length; i++) {
      const x0 = xOf(p.distances[i]);
      const x1 = xOf(p.distances[i + 1]);
      ctx.fillStyle = gradientColor(p.smoothedGradient[i]);
      ctx.beginPath();
      ctx.moveTo(x0, base);
      ctx.lineTo(x0, yOf(p.smoothed[i]));
      ctx.lineTo(x1, yOf(p.smoothed[i + 1]));
      ctx.lineTo(x1, base);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    this.trace(ctx, p.distances, p.original, xOf, yOf, ORIGINAL_COLOR, 1);
    this.trace(ctx, p.distances, p.smoothed, xOf, yOf, SMOOTHED_COLOR, 2);

    this.axes(ctx, plot, total, `${Math.round(hi)} m`, `${Math.round(lo)} m`);
    this.cursor(ctx, plot, xOf);
  }

  private drawGradient(): void {
    const chart = this.gradientChart;
    const { ctx } = chart;
    ctx.clearRect(0, 0, chart.width, chart.height);
    const p = this.profile;
    if (!p) return;
    const plot = chart.plot();
    const total = this.total() || 1;
    const [gLo, gHi] = extent(p.originalGradient, p.smoothedGradient, [p.params.minGradient, p.params.maxGradient]);
    const hi = Math.min(GRADIENT_AXIS_LIMIT, gHi);
    const lo = Math.max(-GRADIENT_AXIS_LIMIT, gLo);
    const span = Math.max(1, hi - lo);
    const xOf = (d: number) => xForDistance(d, plot, total);
    const yOf = (g: number) => plot.y + plot.h - ((Math.max(lo, Math.min(hi, g)) - lo) / span) * plot.h;

    // zero, and the limits the smoothed trace must stay inside
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(plot.x, yOf(0));
    ctx.lineTo(plot.x + plot.w, yOf(0));
    ctx.stroke();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(240,195,60,0.45)';
    for (const limit of [p.params.minGradient, p.params.maxGradient]) {
      ctx.beginPath();
      ctx.moveTo(plot.x, yOf(limit));
      ctx.lineTo(plot.x + plot.w, yOf(limit));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // A gradient belongs to a segment, so each is drawn flat across it.
    const steps = (grade: number[], color: string, width: number) => {
      ctx.beginPath();
      grade.forEach((g, i) => {
        const y = yOf(g);
        if (i === 0) ctx.moveTo(xOf(p.distances[0]), y); else ctx.lineTo(xOf(p.distances[i]), y);
        ctx.lineTo(xOf(p.distances[i + 1]), y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    steps(p.originalGradient, ORIGINAL_COLOR, 1);
    steps(p.smoothedGradient, SMOOTHED_COLOR, 2);

    this.axes(ctx, plot, total, `${signed(hi, 0)}%`, `${signed(lo, 0)}%`);
    this.cursor(ctx, plot, xOf);
  }

  private trace(
    ctx: CanvasRenderingContext2D, xs: number[], ys: number[],
    xOf: (d: number) => number, yOf: (v: number) => number, color: string, width: number,
  ): void {
    ctx.beginPath();
    xs.forEach((d, i) => { if (i === 0) ctx.moveTo(xOf(d), yOf(ys[i])); else ctx.lineTo(xOf(d), yOf(ys[i])); });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  private axes(ctx: CanvasRenderingContext2D, plot: Plot, total: number, top: string, bottom: string): void {
    ctx.font = '12px ui-monospace, Menlo, monospace';
    ctx.fillStyle = 'rgba(147,161,180,0.7)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(top, plot.x - 6, plot.y + 4);
    ctx.fillText(bottom, plot.x - 6, plot.y + plot.h - 4);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('0', plot.x, plot.y + plot.h + 16);
    ctx.fillText(`${(total / 1000).toFixed(1)} km`, plot.x + plot.w - 18, plot.y + plot.h + 16);
  }

  private cursor(ctx: CanvasRenderingContext2D, plot: Plot, xOf: (d: number) => number): void {
    if (this.hoverDistance === undefined) return;
    const x = xOf(this.hoverDistance);
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
