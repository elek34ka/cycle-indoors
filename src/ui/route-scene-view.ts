import { Course } from '../activity/course';
import type { ActivityTrack } from '../activity/types';
import { settings } from '../core/settings';
import { ChunkPlanner } from '../scene/chunks';
import { climbAt, climbBanner, findClimbs, type Climb } from '../scene/climbs';
import { firstPerson } from '../scene/camera';
import { buildGeometry, routeSeed } from '../scene/geometry';
import { buildGround } from '../scene/ground';
import { buildPasses, drawnAt } from '../scene/passes';
import { FAST_FORWARDS, Playback, POWER_MAX, POWER_MIN, type FastForward } from '../scene/playback';
import { ViewPose } from '../scene/pose';
import { buildLand } from '../scene/landscape';
import { buildViewProfile } from '../scene/view-profile';
import {
  DEFAULT_RESOLUTION, NoWebGLError, RESOLUTIONS,
  type RendererLoader, type Resolution, type SceneModel, type SceneRenderer,
} from '../scene/render/types';
import { clear, el } from './dom';
import { distanceForX, drawElevationProfile, elevationPlot } from './elevation-graph';

/**
 * Route 3D preview: a separate window that rides a route in pixelated 3D on
 * simulated power. It reads the route and nothing else: the ride, its course,
 * the session and any trainer are never touched, so it can be opened mid-ride.
 */

export const EXAGGERATION_MIN = 1;
export const EXAGGERATION_MAX = 4;
export const EXAGGERATION_DEFAULT = 2.5;
/** pieces built at once when the view opens or jumps, so the road is there on the first frame */
const BUILD_AHEAD = 6;
/** the profile and readouts are redrawn at most this often while playing */
const READOUT_INTERVAL = 0.25;

export const MESSAGES = {
  loading: 'Loading the 3D view…',
  loadFailed: 'The 3D view could not be loaded. Check the connection and try again.',
  noWebgl: 'This browser cannot show 3D: WebGL is not available.',
  contextLost: 'The 3D view stopped. Close it and open it again.',
} as const;

const RESOLUTION_LABELS: Record<Resolution, string> = { chunky: 'Chunky', medium: 'Medium', fine: 'Fine' };

/** Why a track cannot be shown in 3D, or undefined if it can. */
export function sceneProblem(track: ActivityTrack): string | undefined {
  const located = track.points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  return located.length < 2 ? 'it is not a route: it has fewer than two GPS points' : undefined;
}

const defaultLoader: RendererLoader = () => import('../scene/render/scene-renderer').then((m) => m.createSceneRenderer);

export interface RouteSceneOptions {
  track: ActivityTrack;
  /** shown in the title */
  name: string;
  loadRenderer?: RendererLoader;
  /** frame scheduling, replaceable in tests */
  requestFrame?: (callback: (time: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  onClose?: () => void;
}

let current: RouteSceneView | undefined;

/** Opens the 3D view of a route, replacing any open one. */
export function openRouteScene(options: RouteSceneOptions): RouteSceneView {
  current?.close();
  current = new RouteSceneView(options);
  return current;
}

/** The open 3D view, if any. */
export function openRouteSceneView(): RouteSceneView | undefined {
  return current;
}

export class RouteSceneView {
  readonly element: HTMLElement;
  private readonly course: Course;
  private readonly model: SceneModel;
  private readonly planner: ChunkPlanner;
  private readonly climbs: Climb[];
  private readonly playback: Playback;
  private readonly pose = new ViewPose();
  private renderer: SceneRenderer | undefined;
  private exaggeration = EXAGGERATION_DEFAULT;
  private resolution: Resolution = DEFAULT_RESOLUTION;
  private closed = false;
  private frameHandle: number | undefined;
  private lastTime: number | undefined;
  private sinceReadout = Infinity;

  private readonly stage: HTMLElement;
  private readonly message: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly readouts: Record<'distance' | 'gradient' | 'elevation' | 'speed', HTMLElement>;
  private readonly profile: HTMLCanvasElement;
  private readonly powerLabel: HTMLElement;
  private readonly exaggerationLabel: HTMLElement;
  private readonly groups = new Map<string, HTMLButtonElement[]>();

  private readonly requestFrame: (callback: (time: number) => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); }
  };
  private readonly onVisibility = () => {
    if (document.visibilityState === 'visible') { this.lastTime = undefined; this.schedule(); return; }
    this.stopFrames();
    if (this.playback.playing) { this.playback.pause(); this.syncPlay(); }
  };

  constructor(private readonly options: RouteSceneOptions) {
    const problem = sceneProblem(options.track);
    if (problem) throw new Error(problem);
    this.requestFrame = options.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = options.cancelFrame ?? ((h) => cancelAnimationFrame(h));

    // A course of its own: the ride's course and the session are never touched.
    this.course = new Course(options.track);
    const g = buildGeometry(this.course);
    const p = buildPasses(g, buildViewProfile(this.course, g));
    const seed = routeSeed(g);
    this.planner = new ChunkPlanner(g, p);
    const land = buildLand(g, p, seed);
    this.model = {
      g, p, seed, land,
      ground: buildGround(p, seed, g, land),
      chunkRange: (c) => this.planner.chunkRange(c),
    };
    this.climbs = findClimbs(this.course);
    const { riderWeight, bikeWeight } = settings.current;
    this.playback = new Playback(this.course, riderWeight + bikeWeight);

    this.message = el('div', { class: 'scene-message', text: MESSAGES.loading });
    this.banner = el('div', { class: 'scene-banner', attrs: { hidden: '' } });
    this.stage = el('div', { class: 'scene-stage' }, [this.message, this.banner]);
    this.playButton = el('button', { type: 'button', class: 'btn btn-primary scene-play', text: 'Play', on: { click: () => this.togglePlay() } }) as HTMLButtonElement;
    this.powerLabel = el('span', { class: 'scene-power-value', text: `${this.playback.power} W` });
    this.exaggerationLabel = el('span', { class: 'scene-exaggeration-value', text: `${this.exaggeration}×` });
    const value = () => el('span', { class: 'scene-readout-value', text: '—' });
    this.readouts = { distance: value(), gradient: value(), elevation: value(), speed: value() };
    this.profile = el('canvas', { class: 'scene-profile', attrs: { width: '640', height: '120' } }) as HTMLCanvasElement;
    this.profile.addEventListener('click', (event) => this.jumpToProfile(event));

    const power = el('input', {
      type: 'range', class: 'scene-power', min: String(POWER_MIN), max: String(POWER_MAX), step: '10', value: String(this.playback.power),
      attrs: { 'aria-label': 'Power' },
      on: { input: (e: Event) => { this.playback.setPower(Number((e.target as HTMLInputElement).value)); this.powerLabel.textContent = `${this.playback.power} W`; } },
    });
    const exaggeration = el('input', {
      type: 'range', class: 'scene-exaggeration', min: String(EXAGGERATION_MIN), max: String(EXAGGERATION_MAX), step: '0.5', value: String(this.exaggeration),
      attrs: { 'aria-label': 'Height exaggeration' },
      on: { change: (e: Event) => this.setExaggeration(Number((e.target as HTMLInputElement).value)) },
    });

    const readout = (label: string, node: HTMLElement) => el('div', { class: 'scene-readout' }, [el('span', { class: 'scene-readout-label', text: label }), node]);
    const card = el('div', { class: 'summary-card scene-card', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Route 3D preview' } }, [
      el('div', { class: 'scene-head' }, [
        el('h2', { text: `Route 3D preview · ${options.name}` }),
        el('button', { type: 'button', class: 'btn scene-close', text: 'Close', on: { click: () => this.close() } }),
      ]),
      this.stage,
      el('div', { class: 'scene-controls' }, [
        this.playButton,
        this.segmented('ff', FAST_FORWARDS.map((f) => [String(f), `${f}×`]), String(this.playback.fastForward), (v) => { this.playback.fastForward = Number(v) as FastForward; }),
        el('label', { class: 'scene-control' }, ['Power ', power, this.powerLabel]),
        el('label', { class: 'scene-control' }, ['Heights ', exaggeration, this.exaggerationLabel]),
        this.segmented('resolution', (Object.keys(RESOLUTIONS) as Resolution[]).map((r) => [r, RESOLUTION_LABELS[r]]), DEFAULT_RESOLUTION, (v) => this.setResolution(v as Resolution)),
      ]),
      el('div', { class: 'scene-readouts' }, [
        readout('Distance', this.readouts.distance),
        readout('Gradient', this.readouts.gradient),
        readout('Elevation', this.readouts.elevation),
        readout('Speed', this.readouts.speed),
      ]),
      this.profile,
      el('p', { class: 'hint scene-note', text: 'A preview on simulated power: the land and scenery are made up, and the ride is not changed.' }),
    ]);
    this.element = el('div', { class: 'overlay scene-dialog' }, [card]);
    this.element.addEventListener('click', (event) => { if (event.target === this.element) this.close(); });
    document.addEventListener('keydown', this.onKey, true);
    document.addEventListener('visibilitychange', this.onVisibility);
    (document.getElementById('app') ?? document.body).append(this.element);

    this.resetPose();
    this.updateReadouts();
    void this.load(options.loadRenderer ?? defaultLoader);
  }

  /** A row of buttons of which one is pressed. */
  private segmented(name: string, choices: [string, string][], selected: string, choose: (value: string) => void): HTMLElement {
    const buttons = choices.map(([value, label]) => el('button', {
      type: 'button', class: 'btn scene-choice', text: label, dataset: { group: name, value },
      attrs: { 'aria-pressed': String(value === selected) },
      on: {
        click: () => {
          for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === value));
          choose(value);
        },
      },
    }) as HTMLButtonElement);
    this.groups.set(name, buttons);
    return el('div', { class: 'scene-segmented', attrs: { role: 'group', 'aria-label': name } }, buttons);
  }

  private async load(loader: RendererLoader): Promise<void> {
    let create: Awaited<ReturnType<RendererLoader>>;
    try {
      create = await loader();
    } catch {
      if (!this.closed) this.showMessage(MESSAGES.loadFailed);
      return;
    }
    if (this.closed) return;
    let renderer: SceneRenderer;
    try {
      renderer = create(this.model, this.exaggeration);
    } catch (err) {
      this.showMessage(err instanceof NoWebGLError || (err as { code?: string })?.code === 'no-webgl' ? MESSAGES.noWebgl : MESSAGES.loadFailed);
      return;
    }
    if (this.closed) { renderer.dispose(); return; }
    this.renderer = renderer;
    renderer.setResolution(RESOLUTIONS[this.resolution]);
    renderer.onContextLost(() => {
      this.stopFrames();
      this.playback.pause();
      this.syncPlay();
      this.showMessage(MESSAGES.contextLost);
    });
    this.stage.prepend(renderer.canvas);
    this.message.hidden = true;
    this.buildAhead();
    this.schedule();
  }

  private showMessage(text: string): void {
    this.message.textContent = text;
    this.message.hidden = false;
  }

  // ---- controls ------------------------------------------------------------

  private togglePlay(): void {
    if (this.playback.playing) this.playback.pause();
    else {
      const restart = this.playback.atFinish;
      this.playback.play();
      if (restart) this.jumpTo(0);
    }
    this.syncPlay();
  }

  private syncPlay(): void {
    this.playButton.textContent = this.playback.playing ? 'Pause' : 'Play';
  }

  private setExaggeration(value: number): void {
    this.exaggeration = Math.max(EXAGGERATION_MIN, Math.min(EXAGGERATION_MAX, value));
    this.exaggerationLabel.textContent = `${this.exaggeration}×`;
    this.planner.clear();
    this.renderer?.setExaggeration(this.exaggeration);
    this.resetPose();
    this.buildAhead();
  }

  private setResolution(r: Resolution): void {
    this.resolution = r;
    this.renderer?.setResolution(RESOLUTIONS[r]);
  }

  private jumpToProfile(event: MouseEvent): void {
    const rect = this.profile.getBoundingClientRect();
    const scale = rect.width > 0 ? this.profile.width / rect.width : 1;
    const x = (event.clientX - rect.left) * scale;
    const plot = elevationPlot({ width: this.profile.width, height: this.profile.height });
    const d = distanceForX(x, plot, this.course.totalDistance);
    if (d !== undefined) this.jumpTo(d);
  }

  /** Moves the rider to `distance`: the camera cuts there, and the road there is built first. */
  jumpTo(distance: number): void {
    this.playback.jump(distance);
    this.resetPose();
    this.buildAhead();
    this.updateReadouts();
  }

  private resetPose(): void {
    const at = drawnAt(this.model.g, this.model.p, this.playback.distance);
    this.pose.reset(at.heading, at.slope * this.exaggeration);
  }

  // ---- frames --------------------------------------------------------------

  private schedule(): void {
    if (this.closed || this.frameHandle !== undefined || !this.renderer) return;
    if (document.visibilityState === 'hidden') return;
    this.frameHandle = this.requestFrame((time) => { this.frameHandle = undefined; this.frame(time); });
  }

  private stopFrames(): void {
    if (this.frameHandle !== undefined) this.cancelFrame(this.frameHandle);
    this.frameHandle = undefined;
    this.lastTime = undefined;
  }

  private buildAhead(): void {
    if (!this.renderer) return;
    const at = drawnAt(this.model.g, this.model.p, this.playback.distance);
    for (let n = 0; n < BUILD_AHEAD; n++) if (!this.buildOne(at.x, at.z)) break;
  }

  private buildOne(x: number, z: number): boolean {
    const { build, drop } = this.planner.frame(x, z);
    for (const piece of drop) this.renderer?.drop(piece);
    if (build) this.renderer?.build(build);
    return build !== null;
  }

  private frame(time: number): void {
    if (this.closed || !this.renderer) return;
    const wall = this.lastTime === undefined ? 0 : Math.max(0, (time - this.lastTime) / 1000);
    this.lastTime = time;
    const wasPlaying = this.playback.playing;
    const dt = this.playback.step(wall);
    if (wasPlaying && !this.playback.playing) this.syncPlay();

    const at = drawnAt(this.model.g, this.model.p, this.playback.distance);
    const y = (at.h - this.model.ground.base) * this.exaggeration;
    if (dt > 0) this.pose.step({ heading: at.heading, slope: at.slope * this.exaggeration, dt });
    const ground = this.model.ground;
    const view = firstPerson({
      rider: [at.x, y, at.z],
      heading: this.pose.heading,
      pitch: this.pose.pitch,
      groundAt: (x, z) => (ground.surfaceAt(x, z) - ground.base) * this.exaggeration,
    });
    this.buildOne(at.x, at.z);
    this.renderer.render({ rider: [at.x, y, at.z], camera: view });

    this.sinceReadout += wall;
    if (this.sinceReadout >= READOUT_INTERVAL || dt === 0) this.updateReadouts();
    this.schedule();
  }

  // ---- readouts ------------------------------------------------------------

  private updateReadouts(): void {
    this.sinceReadout = 0;
    const d = this.playback.distance;
    const total = this.course.totalDistance;
    // course.at(total) wraps to the start, so the finish is read just before it
    const at = this.course.at(Math.min(d, Math.max(0, total - 1e-6)));
    this.readouts.distance.textContent = `${(d / 1000).toFixed(1)} / ${(total / 1000).toFixed(1)} km`;
    this.readouts.gradient.textContent = this.course.hasElevation ? `${at.gradient.toFixed(1)}%` : '—';
    this.readouts.elevation.textContent = this.course.hasElevation ? `${Math.round(at.ele)} m` : '—';
    this.readouts.speed.textContent = `${(this.playback.speed * 3.6).toFixed(1)} km/h`;

    const climb = climbAt(this.climbs, d);
    if (climb) {
      const b = climbBanner(climb, d);
      clear(this.banner);
      this.banner.append(
        el('span', { class: 'scene-banner-grade', text: b.average }),
        el('span', { class: 'scene-banner-left', text: `${b.left} to the top` }),
      );
      this.banner.hidden = false;
    } else {
      this.banner.hidden = true;
    }

    const ctx = this.profile.getContext('2d');
    if (ctx) {
      drawElevationProfile(ctx, { width: this.profile.width, height: this.profile.height }, {
        course: this.course,
        rider: { distance: d, ele: at.ele, gradient: at.gradient, totalAscent: this.course.totalAscent },
      });
    }
  }

  // ---- closing -------------------------------------------------------------

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopFrames();
    document.removeEventListener('keydown', this.onKey, true);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.planner.clear();
    this.renderer?.dispose();
    this.renderer = undefined;
    this.element.remove();
    if (current === this) current = undefined;
    this.options.onClose?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
