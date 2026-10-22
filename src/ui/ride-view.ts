import { hhmmss, int, dec, mmss } from '../core/format';
import { settings } from '../core/settings';
import { hrZoneColor, zoneForPower } from '../core/zones';
import { courseStore } from '../activity/course-store';
import { gradientColor, type Course } from '../activity/course';
import { mock } from '../devices/setup';
import { session, type SessionSnapshot } from '../session/session';
import { LIBRARY } from '../workout/library';
import { parseZwo } from '../workout/zwo';
import { loadFile } from '../loaders';
import type { Workout } from '../workout/types';
import { clear, el, qs, setClass, setParts, setText, toast, type SubPart } from './dom';
import { confirmDialog } from './confirm';
import { ElevationGraph } from './elevation-graph';
import { MiniMap } from './mini-map';
import { ProfileGraph } from './profile-graph';

interface TileSpec {
  key: string;
  label: (s: SessionSnapshot) => string;
  unit?: string;
  value: (s: SessionSnapshot) => string;
  sub?: (s: SessionSnapshot) => string | SubPart[];
  stripe?: (s: SessionSnapshot) => string | undefined;
  visible?: (s: SessionSnapshot) => boolean;
}

/** "avg 210 · lap 215" — the session and current-lap averages for a metric,
 *  with the numbers as strong parts so they read at a glance from the saddle. */
export function averages(avg: number | undefined, lap: number | undefined): SubPart[] {
  const parts: SubPart[] = [];
  for (const [name, value] of [['avg', avg], ['lap', lap]] as const) {
    if (value === undefined) continue;
    parts.push({ text: `${parts.length ? ' · ' : ''}${name} ` }, { text: String(Math.round(value)), strong: true });
  }
  return parts;
}

/** The parts, or the fallback text when there are none. */
const orElse = (parts: SubPart[], fallback: string): SubPart[] | string => (parts.length ? parts : fallback);

const TILES: TileSpec[] = [
  {
    key: 'power',
    label: () => `Power ${settings.current.smoothPowerSeconds}s`,
    unit: 'W',
    value: (s) => int(s.smoothedPower),
    sub: (s) => orElse(averages(s.avgPower, s.lapAvgPower), `${settings.current.smoothPowerSeconds}s average`),
    stripe: (s) => (s.smoothedPower === undefined ? undefined : zoneForPower(s.smoothedPower, settings.current.ftp).color),
  },
  {
    key: 'target',
    label: () => 'Target',
    unit: 'W',
    value: (s) => (s.effectiveMode === 'free' ? '—' : int(s.targetPower)),
    sub: (s) => {
      // Without a controllable trainer the target is only advice, and saying so
      // is better than letting the rider wonder why the brake is not moving.
      if (!s.canControlTrainer) return 'no trainer control';
      if (s.effectiveMode === 'free') {
        return s.followCourse ? `route ${dec(s.effectiveGrade, 1)}%` : `grade ${dec(s.effectiveGrade, 1)}%`;
      }
      const delta = s.smoothedPower !== undefined && s.targetPower > 0 ? s.smoothedPower - s.targetPower : undefined;
      const bias = Math.round(s.ergBias * 100);
      return delta === undefined ? `bias ${bias}%` : `${delta >= 0 ? '+' : ''}${delta} W · bias ${bias}%`;
    },
    stripe: (s) => (s.targetPower > 0 ? zoneForPower(s.targetPower, settings.current.ftp).color : undefined),
  },
  {
    key: 'hr',
    label: () => `Heart rate ${settings.current.smoothPowerSeconds}s`,
    unit: 'bpm',
    value: (s) => int(s.smoothedHeartRate),
    sub: (s) => orElse(averages(s.avgHeartRate, s.lapAvgHeartRate), 'no strap'),
    stripe: (s) => (s.smoothedHeartRate ? hrZoneColor(s.smoothedHeartRate, settings.current.hrMax) : undefined),
  },
  {
    key: 'cadence',
    label: () => 'Cadence',
    unit: 'rpm',
    value: (s) => int(s.live.cadence),
    sub: (s) => (s.targetCadence ? `target ${s.targetCadence}` : ''),
  },
  {
    key: 'speed',
    label: () => 'Speed',
    unit: 'km/h',
    value: (s) => dec(s.speed, 1),
    sub: (s) => `${(s.distance / 1000).toFixed(2)} km`,
  },
  {
    key: 'ascent',
    label: () => 'Climbed',
    unit: 'm',
    value: (s) => int(s.coursePosition?.totalAscent),
    sub: (s) => {
      const course = courseStore.current;
      if (!course || !s.coursePosition) return '';
      const grade = `${s.coursePosition.gradient >= 0 ? '+' : ''}${s.coursePosition.gradient.toFixed(1)}%`;
      return `${grade} · ${Math.round(course.totalAscent)} m/lap`;
    },
    stripe: (s) => (s.coursePosition ? gradientColor(s.coursePosition.gradient) : undefined),
    visible: (s) => s.coursePosition !== undefined,
  },
  {
    key: 'time',
    label: () => 'Elapsed',
    value: (s) => hhmmss(s.elapsed),
    sub: (s) => {
      if (s.workoutComplete) return 'workout done · free riding';
      return s.remaining === undefined ? 'open ride' : `${hhmmss(s.remaining)} left`;
    },
  },
];

export class RideView {
  private graph: ProfileGraph;
  private elevation: ElevationGraph;
  private miniMap: MiniMap;
  private tiles = new Map<string, { value: HTMLElement; sub: HTMLElement; stripe: HTMLElement; label: HTMLElement; root: HTMLElement }>();
  private segmentNodes: HTMLLIElement[] = [];
  private renderedSegmentIndex = -1;
  private messageNode: HTMLElement;
  private intervalBar: HTMLElement;
  private controls: HTMLElement;
  private workoutMeta: HTMLElement;
  private segmentList: HTMLElement;
  private startBtn!: HTMLButtonElement;
  private sidebarBtn!: HTMLButtonElement;
  private modeButtons = new Map<string, HTMLButtonElement>();
  private biasGroup!: HTMLElement;
  private gradeGroup!: HTMLElement;
  private legsGroup!: HTMLElement;
  private biasReadout!: HTMLElement;
  private gradeReadout!: HTMLElement;
  private gradeInput!: HTMLInputElement;
  private followLabel!: HTMLElement;
  private followInput!: HTMLInputElement;
  private currentMessage: string | undefined;

  constructor(private onFinished: (snapshot: SessionSnapshot) => void) {
    this.messageNode = qs('#graph-message');
    this.intervalBar = qs('#interval-bar');
    this.controls = qs('#controls');
    this.workoutMeta = qs('#workout-meta');
    this.segmentList = qs('#segment-list');

    this.graph = new ProfileGraph(qs<HTMLCanvasElement>('#profile'), (seconds) => {
      if (session.snapshot.workout) session.seek(seconds - session.snapshot.elapsed);
    });
    this.miniMap = new MiniMap(qs('#mini-map-host'));
    this.elevation = new ElevationGraph(qs<HTMLCanvasElement>('#elevation'), (distance) => {
      const course = courseStore.current;
      this.miniMap.setHover(distance === undefined || !course ? undefined : course.at(distance));
    });

    this.sidebarBtn = qs<HTMLButtonElement>('#toggle-sidebar');
    this.sidebarBtn.addEventListener('click', () => this.setSidebarVisible(!settings.current.showSidebar));

    this.buildTiles();
    this.buildControls();
    this.buildWorkoutPanel();
    this.buildRoutePanel();

    session.on('tick', (s) => this.render(s));
    session.on('workout', (w) => this.onWorkoutChanged(w));
    session.on('finished', (s) => this.onFinished(s));
    session.on('state', () => this.render(session.snapshot));
    settings.on('change', () => this.render(session.snapshot));
    courseStore.on('course', (c) => this.onCourseChanged(c));

    this.bindKeys();
    this.applySidebar(settings.current.showSidebar);
    this.loadLibraryWorkout(LIBRARY[0].id);
    this.onCourseChanged(undefined);
  }

  // ---- construction --------------------------------------------------------

  private buildTiles(): void {
    const host = qs('#metrics');
    clear(host);
    for (const spec of TILES) {
      const stripe = el('div', { class: 'tile-stripe' });
      const value = el('span', { text: '--' });
      const sub = el('div', { class: 'tile-sub', text: '' });
      const label = el('div', { class: 'tile-label', text: spec.label(session.snapshot) });
      const root = el('div', { class: 'tile' }, [
        stripe,
        label,
        el('div', { class: 'tile-value' }, [value, spec.unit ? el('span', { class: 'tile-unit', text: spec.unit }) : null]),
        sub,
      ]);
      host.append(root);
      this.tiles.set(spec.key, { value, sub, stripe, label, root });
    }
  }

  private buildControls(): void {
    clear(this.controls);


    this.startBtn = el('button', {
      class: 'btn btn-primary', text: 'Start',
      on: { click: () => void this.pressStart() },
    });
    const finish = el('button', { class: 'btn btn-danger', text: 'Finish', on: { click: () => session.finish() } });
    const lap = el('button', { class: 'btn', text: 'Lap', title: 'Mark a lap (L)', on: { click: () => session.markLap() } });

    const modeToggle = el('div', { class: 'toggle' });
    for (const mode of ['erg', 'free'] as const) {
      const btn = el('button', {
        text: mode === 'erg' ? 'ERG' : 'Free',
        title: mode === 'erg' ? 'Trainer holds the workout target' : 'Trainer emulates a gradient; you choose the effort',
        on: { click: () => session.setMode(mode) },
      });
      this.modeButtons.set(mode, btn);
      modeToggle.append(btn);
    }

    this.biasReadout = el('div', { class: 'readout', text: '100%' });
    this.biasGroup = el('div', { class: 'group' }, [
      el('label', { text: 'Bias' }),
      el('button', { class: 'btn btn-small', text: '−', on: { click: () => session.nudgeBias(-0.01) } }),
      this.biasReadout,
      el('button', { class: 'btn btn-small', text: '+', on: { click: () => session.nudgeBias(0.01) } }),
    ]);

    this.gradeInput = el('input', { type: 'range', min: '-10', max: '20', step: '0.5', value: '0' }) as HTMLInputElement;
    this.gradeInput.addEventListener('input', () => session.setGrade(Number(this.gradeInput.value)));
    this.gradeReadout = el('div', { class: 'readout', text: '0.0%' });

    this.followInput = el('input', { type: 'checkbox' }) as HTMLInputElement;
    this.followInput.addEventListener('change', () => session.setFollowCourse(this.followInput.checked));
    this.followLabel = el('label', { class: 'check', title: 'Take the gradient from the loaded route instead of the slider' }, [
      this.followInput, el('span', { text: 'Follow route' }),
    ]);

    this.gradeGroup = el('div', { class: 'group' }, [
      el('label', { text: 'Grade' }), this.gradeInput, this.gradeReadout, this.followLabel,
    ]);

    const legs = el('input', { type: 'range', min: '0', max: '150', step: '5', value: '65' }) as HTMLInputElement;
    const legsReadout = el('div', { class: 'readout', text: '65%' });
    legs.addEventListener('input', () => {
      mock.rig.riderEffort = Number(legs.value) / 100;
      legsReadout.textContent = `${legs.value}%`;
    });
    this.legsGroup = el('div', { class: 'group', title: 'How hard the simulated rider pedals in free mode' }, [
      el('label', { text: 'Sim legs' }), legs, legsReadout,
    ]);

    this.controls.append(
      el('div', { class: 'group' }, [this.startBtn, finish, lap]),
      el('div', { class: 'group' }, [el('label', { text: 'Mode' }), modeToggle]),
      this.biasGroup,
      this.gradeGroup,
      el('div', { class: 'group' }, [
        el('label', { text: 'Jump' }),
        el('button', { class: 'btn btn-small', text: '|◀', title: 'Previous block', on: { click: () => session.skipSegment(-1) } }),
        el('button', { class: 'btn btn-small', text: '−30s', on: { click: () => session.seek(-30) } }),
        el('button', { class: 'btn btn-small', text: '+30s', on: { click: () => session.seek(30) } }),
        el('button', { class: 'btn btn-small', text: '▶|', title: 'Next block', on: { click: () => session.skipSegment(1) } }),
      ]),
      el('div', { class: 'spacer' }),
      this.legsGroup,
    );
  }

  /** Folds the workout/route panel away so the ride gets the whole width. */
  setSidebarVisible(visible: boolean): void {
    settings.patch({ showSidebar: visible });
    this.applySidebar(visible);
  }

  private applySidebar(visible: boolean): void {
    qs('#view-ride').classList.toggle('sidebar-hidden', !visible);
    this.sidebarBtn.textContent = visible ? '◀ Panel' : '▶ Panel';
    this.sidebarBtn.title = `${visible ? 'Hide' : 'Show'} the workout and route panel (W)`;
    this.sidebarBtn.setAttribute('aria-pressed', String(visible));
  }

  private attachLoader(buttonId: string, dropId: string, accept: string, handler: (file: File) => void): void {
    const input = el('input', { type: 'file' }) as HTMLInputElement;
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) handler(file);
      input.value = '';
    });
    document.body.append(input);
    qs(`#${buttonId}`).addEventListener('click', () => input.click());

    const drop = qs(`#${dropId}`);
    const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
    drop.addEventListener('dragover', (e) => { stop(e); drop.classList.add('over'); });
    drop.addEventListener('dragleave', (e) => { stop(e); drop.classList.remove('over'); });
    drop.addEventListener('drop', (e) => {
      stop(e);
      drop.classList.remove('over');
      const file = (e as DragEvent).dataTransfer?.files?.[0];
      if (file) handler(file);
    });
  }

  private buildWorkoutPanel(): void {
    const select = qs<HTMLSelectElement>('#library-select');
    clear(select);
    select.append(el('option', { value: '', text: 'Workout library…' }));
    for (const entry of LIBRARY) {
      select.append(el('option', { value: entry.id, text: `${entry.title} — ${entry.summary.split(' · ')[0]}` }));
    }
    select.addEventListener('change', () => {
      if (select.value) this.loadLibraryWorkout(select.value);
    });
    this.attachLoader('pick-workout', 'workout-drop', '.zwo,.fit,.xml', (file) => void this.loadFromFile(file));
  }

  private buildRoutePanel(): void {
    this.attachLoader('pick-route', 'route-drop', '.gpx,.fit', (file) => void this.loadFromFile(file));
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (!qs('#view-ride').classList.contains('active')) return;
      switch (e.key) {
        case ' ': e.preventDefault(); void this.pressStart(); break;
        case 'ArrowUp': e.preventDefault(); session.nudgeBias(0.01); break;
        case 'ArrowDown': e.preventDefault(); session.nudgeBias(-0.01); break;
        case 'ArrowRight': e.preventDefault(); session.seek(e.shiftKey ? 60 : 10); break;
        case 'ArrowLeft': e.preventDefault(); session.seek(e.shiftKey ? -60 : -10); break;
        case 'l': case 'L': session.markLap(); break;
        case 'w': case 'W':
          if (!e.metaKey && !e.ctrlKey && !e.altKey) this.setSidebarVisible(!settings.current.showSidebar);
          break;
        case 'm': case 'M':
          if (this.miniMap.available) this.miniMap.setVisible(!settings.current.showMiniMap);
          else toast('Load a .gpx or .fit route to get a map.');
          break;
        default: break;
      }
    });
  }

  /**
   * Start, pause, resume — or, on a finished ride, begin a new one. That last
   * case throws the recorded ride away, so it asks first unless the rider has
   * already downloaded it.
   */
  private async pressStart(): Promise<void> {
    const s = session.snapshot;
    if (s.state === 'finished' && s.samples.length > 0 && !s.exported) {
      const keep = !(await confirmDialog({
        title: 'Start a new ride?',
        message: `This will discard ${hhmmss(s.samples.length)} of riding that has not been `
          + 'downloaded. Download the .fit file first if you want to keep it.',
        confirmText: 'Discard and start new',
        cancelText: 'Keep this ride',
        danger: true,
      }));
      if (keep) return;
    }
    session.toggle();
  }

  // ---- loading -------------------------------------------------------------

  private loadLibraryWorkout(id: string): void {
    const entry = LIBRARY.find((e) => e.id === id);
    if (!entry) return;
    try {
      const workout = parseZwo(entry.zwo, { ftp: settings.current.ftp });
      workout.source = 'builtin';
      session.loadWorkout(workout);
      qs<HTMLSelectElement>('#library-select').value = id;
    } catch (err) {
      toast(`Could not load "${entry.title}": ${(err as Error).message}`, 'error');
    }
  }

  async loadFromFile(file: File): Promise<void> {
    try {
      const result = await loadFile(file, { ftp: settings.current.ftp });
      if (result.workout) {
        session.loadWorkout(result.workout);
        qs<HTMLSelectElement>('#library-select').value = '';
        toast(`Loaded "${result.workout.name}" — ${hhmmss(result.workout.duration)}`);
      }
      if (result.track) {
        const course = courseStore.load(result.track);
        if (course) {
          toast(`Route "${course.name}" — ${(course.totalDistance / 1000).toFixed(1)} km, ${Math.round(course.totalAscent)} m up`);
        } else {
          toast('Loaded, but this ride has no GPS positions — indoor rides have no route.');
        }
      }
      if (!result.workout && !result.track) toast('Nothing usable in that file.', 'error');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  private onCourseChanged(course: Course | undefined): void {
    this.elevation.setCourse(course);
    this.miniMap.setCourse(course);
    setClass(qs('#graph-stack'), 'no-route', course === undefined);
    this.renderRouteStats(course);
    this.render(session.snapshot);
  }

  private renderRouteStats(course: Course | undefined): void {
    const host = qs('#route-stats');
    clear(host);
    if (!course) {
      const track = courseStore.track;
      host.append(el('div', {
        class: 'empty',
        text: track
          ? 'That ride has no GPS track — indoor rides have no route to draw.'
          : 'No route loaded.',
      }));
      return;
    }
    const track = course.track;
    const rows: [string, string][] = [
      ['Distance', `${(course.totalDistance / 1000).toFixed(2)} km`],
      ['Ascent', `${Math.round(course.totalAscent)} m`],
      ['Descent', `${Math.round(course.totalDescent)} m`],
      ['Elevation', `${Math.round(course.minEle)} – ${Math.round(course.maxEle)} m`],
    ];
    if (track?.elapsed) rows.push(['Recorded in', hhmmss(track.elapsed)]);
    if (track?.hasPower) rows.push(['Avg power', `${int(track.avgPower)} W`]);
    if (track?.hasHr) rows.push(['Avg HR', `${int(track.avgHr)} bpm`]);
    rows.push(['Points', String(course.points.length)]);

    host.append(el('div', { class: 'row' }, [el('span', { text: 'Route' }), el('strong', { text: course.name })]));
    for (const [label, value] of rows) {
      host.append(el('div', { class: 'row' }, [el('span', { text: label }), el('strong', { text: value })]));
    }
    host.append(el('button', {
      class: 'btn btn-small',
      text: 'Clear route',
      on: { click: () => courseStore.unload() },
    }));
  }

  private onWorkoutChanged(workout: Workout | undefined): void {
    this.graph.setWorkout(workout);
    this.renderedSegmentIndex = -1;
    clear(this.workoutMeta);
    clear(this.segmentList);
    this.segmentNodes = [];

    if (!workout) {
      this.workoutMeta.append(el('p', { text: 'No workout loaded — free riding.' }));
      return;
    }

    const blocks = workout.segments.length;
    const meta: (Node | null)[] = [
      el('h3', { text: workout.name }),
      el('div', { class: 'meta-row' }, [
        el('span', { text: hhmmss(workout.duration) }),
        el('span', { text: `${blocks} block${blocks === 1 ? '' : 's'}` }),
        el('span', { text: workout.source.toUpperCase() }),
      ]),
      workout.author ? el('p', { text: `by ${workout.author}` }) : null,
      workout.description ? el('p', { text: workout.description }) : null,
      ...(workout.warnings ?? []).map((w) => el('div', { class: 'warn', text: `! ${w}` })),
    ];
    this.workoutMeta.append(...meta.filter((node): node is Node => node !== null));

    const ftp = workout.ftpOverride ?? settings.current.ftp;
    workout.segments.forEach((seg) => {
      const mid = seg.powerStart === undefined ? undefined : ((seg.powerStart + (seg.powerEnd ?? seg.powerStart)) / 2);
      const color = mid === undefined ? '#7a8694' : zoneForPower(mid * ftp, ftp).color;
      const node = el('li', {
        dataset: { index: String(seg.index) },
        on: { click: () => session.seek(seg.start - session.snapshot.elapsed) },
      }, [
        el('div', { class: 'bar' }),
        el('div', { class: 'label', text: seg.label }),
        el('div', { class: 'dur', text: mmss(seg.duration) }),
      ]);
      (node.firstElementChild as HTMLElement).style.background = color;
      this.segmentList.append(node);
      this.segmentNodes.push(node);
    });
  }

  // ---- rendering -----------------------------------------------------------

  private render(s: SessionSnapshot): void {
    for (const spec of TILES) {
      const tile = this.tiles.get(spec.key);
      if (!tile) continue;
      const visible = spec.visible?.(s) ?? true;
      tile.root.style.display = visible ? '' : 'none';
      if (!visible) continue;
      setText(tile.label, spec.label(s));
      setText(tile.value, spec.value(s));
      const sub = spec.sub?.(s) ?? '';
      if (typeof sub === 'string') setText(tile.sub, sub);
      else setParts(tile.sub, sub);
      setClass(tile.sub, 'has-parts', typeof sub !== 'string');
      const stripe = spec.stripe?.(s);
      tile.stripe.style.background = stripe ?? 'transparent';
      setClass(tile.root, 'accent', Boolean(stripe));
    }

    setText(this.startBtn, s.state === 'running'
      ? 'Pause'
      : s.state === 'finished'
        ? 'Start new ride'
        : s.elapsed > 0 ? 'Resume' : 'Start');
    setClass(this.startBtn, 'btn-primary', s.state !== 'running');

    for (const [mode, btn] of this.modeButtons) setClass(btn, 'on', s.mode === mode);
    this.biasGroup.style.display = s.effectiveMode === 'erg' ? '' : 'none';
    this.gradeGroup.style.display = s.effectiveMode === 'free' ? '' : 'none';
    this.legsGroup.style.display = s.effectiveMode === 'free' && mock.trainer.status === 'connected' ? '' : 'none';
    this.followLabel.style.display = courseStore.current ? '' : 'none';
    if (this.followInput.checked !== s.followCourse) this.followInput.checked = s.followCourse;
    this.gradeInput.disabled = s.followCourse;
    setText(this.biasReadout, `${Math.round(s.ergBias * 100)}%`);
    setText(this.gradeReadout, `${s.effectiveGrade.toFixed(1)}%`);
    this.gradeReadout.style.color = s.followCourse ? gradientColor(s.effectiveGrade) : '';
    if (document.activeElement !== this.gradeInput) this.gradeInput.value = String(s.grade);

    this.renderIntervalBar(s);
    this.renderSegmentList(s);

    if (s.message !== this.currentMessage) {
      this.currentMessage = s.message;
      setText(this.messageNode, s.message ?? '');
      setClass(this.messageNode, 'show', Boolean(s.message));
    }

    this.graph.render(s);
    this.elevation.render(s);

    // Fed every frame: the map does its own easing, and throttling here is what
    // made it move in visible steps.
    if (s.coursePosition) this.miniMap.setRider(s.coursePosition.lat, s.coursePosition.lon);
  }

  private renderIntervalBar(s: SessionSnapshot): void {
    const bar = this.intervalBar;
    if (s.workoutComplete) {
      if (bar.dataset.built !== 'complete') {
        clear(bar);
        bar.append(
          el('div', { class: 'mode-flag free', text: 'free' }),
          el('div', { class: 'now', text: `${s.workout?.name ?? 'Workout'} complete — free riding` }),
          el('div', { class: 'next', text: 'press Finish when you are done' }),
        );
        bar.dataset.built = 'complete';
      }
      return;
    }
    if (!s.workout || !s.segment) {
      if (bar.dataset.built !== 'free') {
        clear(bar);
        bar.append(el('div', { class: 'mode-flag free', text: 'free' }), el('div', { class: 'now', text: 'No workout loaded — open ride' }));
        bar.dataset.built = 'free';
      }
      return;
    }
    if (bar.dataset.built !== 'workout') {
      clear(bar);
      bar.append(
        el('div', { class: 'mode-flag' }),
        el('div', { class: 'now' }),
        el('div', { class: 'countdown' }),
        el('div', { class: 'next' }),
      );
      bar.dataset.built = 'workout';
    }
    const [flag, now, countdown, next] = Array.from(bar.children) as HTMLElement[];
    const free = s.effectiveMode === 'free';
    setText(flag, free ? 'free' : 'erg');
    setClass(flag, 'free', free);
    setText(now, `${s.segment.kind} · ${s.segment.label}`);
    setText(countdown, mmss(s.segmentRemaining));
    setText(next, s.nextSegment ? `next: ${s.nextSegment.label} (${mmss(s.nextSegment.duration)})` : 'last block');
  }

  private renderSegmentList(s: SessionSnapshot): void {
    const index = s.workoutComplete ? this.segmentNodes.length : s.segmentIndex;
    if (index === this.renderedSegmentIndex) return;
    this.renderedSegmentIndex = index;
    this.segmentNodes.forEach((node, i) => {
      setClass(node, 'current', i === index);
      setClass(node, 'done', i < index);
    });
    const current = this.segmentNodes[index];
    if (typeof current?.scrollIntoView === 'function') current.scrollIntoView({ block: 'nearest' });
  }
}
