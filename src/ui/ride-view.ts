import { hhmmss, int, dec, mmss } from '../core/format';
import { settings } from '../core/settings';
import { hrZoneColor, riderZones, zoneForPower } from '../core/zones';
import { courseStore } from '../activity/course-store';
import { gradientColor, type Course } from '../activity/course';
import { mock } from '../devices/setup';
import {
  MAX_TARGET_WATTS, MIN_TARGET_WATTS, session, type FreeTarget, type SessionSnapshot,
} from '../session/session';
import { LIBRARY } from '../workout/library';
import { parseZwo } from '../workout/zwo';
import { loadFile } from '../loaders';
import type { PersonalLibrary } from '../library/personal';
import { rememberEntry, rememberRoute, type LoadedEntries } from '../library/loaded';
import { blockLabel } from '../workout/targets';
import type { Workout } from '../workout/types';
import { clear, el, qs, setClass, setParts, setText, toast, type SubPart } from './dom';
import { confirmDialog } from './confirm';
import { ElevationGraph } from './elevation-graph';
import { MiniMap } from './mini-map';
import { ProfileGraph } from './profile-graph';

/** Where a loaded file came from: picked or dropped by the rider, the
 *  published catalog, or the rider's own library in the browser. */
export type LoadOrigin = 'file' | 'catalog' | 'mine';

/** One row of a tile's right-hand column: plain text, or parts with the
 *  numbers emphasised. */
type SideRow = string | SubPart[];

interface TileSpec {
  key: string;
  label: (s: SessionSnapshot) => string;
  unit?: string;
  value: (s: SessionSnapshot) => string;
  /** up to two rows beside the value, right-aligned; empty rows are hidden */
  side?: (s: SessionSnapshot) => SideRow[];
  stripe?: (s: SessionSnapshot) => string | undefined;
  /** the value alone, sized to fill the tile */
  hero?: boolean;
}

/** A number in bold beside its quieter unit or name, e.g. "32.4 km/h". */
const figure = (value: string, unit: string): SubPart[] => [{ text: value, strong: true }, { text: ` ${unit}` }];

/** "avg 210" over "lap 215" — the session and current-lap averages for a
 *  metric, with the numbers as strong parts so they read at a glance. */
export function averages(avg: number | undefined, lap: number | undefined): SubPart[][] {
  const rows: SubPart[][] = [];
  for (const [name, value] of [['avg', avg], ['lap', lap]] as const) {
    if (value === undefined) continue;
    rows.push([{ text: `${name} ` }, { text: String(Math.round(value)), strong: true }]);
  }
  return rows;
}

/** The rows, or the fallback text when there are none. */
const orElse = (rows: SubPart[][], fallback: string): SideRow[] => (rows.length ? rows : [fallback]);

/** The FTP a workout's percentages are taken against: its own, if the file set
 *  one, otherwise the rider's. */
const effectiveFtp = (workout: Workout): number => workout.ftpOverride ?? settings.current.ftp;
/** The FTP the ride is measured against right now, workout or not. */
const rideFtp = (s: SessionSnapshot): number => (s.workout ? effectiveFtp(s.workout) : settings.current.ftp);
/** The rider's zones, as Settings has them now, so an edit shows mid-ride. */
const zones = () => riderZones(settings.current);

const TILES: TileSpec[] = [
  {
    key: 'power',
    label: () => `Power ${settings.current.smoothPowerSeconds}s`,
    unit: 'W',
    value: (s) => int(s.smoothedPower),
    side: (s) => orElse(averages(s.avgPower, s.lapAvgPower), `${settings.current.smoothPowerSeconds}s average`),
    stripe: (s) => (s.smoothedPower === undefined ? undefined : zoneForPower(s.smoothedPower, rideFtp(s), zones().power).color),
  },
  {
    key: 'target',
    label: () => 'Target',
    unit: 'W',
    value: (s) => (s.controlMode === 'grade' ? '—' : int(s.targetPower)),
    side: (s) => {
      // Without a controllable trainer the target is only advice, and saying so
      // is better than letting the rider wonder why the brake is not moving.
      if (!s.canControlTrainer) return ['no trainer control'];
      // The figures speak for themselves: a gradient held, then the block's cadence.
      const rows: SideRow[] = [];
      if (s.controlMode === 'grade') rows.push([{ text: `${dec(s.effectiveGrade, 1)}%`, strong: true }]);
      if (s.targetCadence) rows.push(figure(String(s.targetCadence), 'rpm'));
      return rows;
    },
    stripe: (s) => (s.targetPower > 0 ? zoneForPower(s.targetPower, rideFtp(s), zones().power).color : undefined),
  },
  {
    key: 'hr',
    label: () => `Heart rate ${settings.current.smoothPowerSeconds}s`,
    unit: 'bpm',
    value: (s) => int(s.smoothedHeartRate),
    side: (s) => orElse(averages(s.avgHeartRate, s.lapAvgHeartRate), 'no strap'),
    stripe: (s) => (s.smoothedHeartRate ? hrZoneColor(s.smoothedHeartRate, settings.current.hrMax, zones().hr) : undefined),
  },
  {
    key: 'cadence',
    label: () => 'Cadence',
    unit: 'rpm',
    value: (s) => int(s.live.cadence),
    side: (s) => [figure(dec(s.speed, 1), 'km/h'), figure((s.distance / 1000).toFixed(2), 'km')],
  },
  {
    key: 'time',
    label: () => 'Elapsed',
    value: (s) => hhmmss(s.elapsed),
    hero: true,
  },
];

/** The zone colour a tile's stripe shows for `s`, or undefined for none. */
export function tileStripe(key: string, s: SessionSnapshot): string | undefined {
  return TILES.find((t) => t.key === key)?.stripe?.(s);
}

function wattsInput(title: string): HTMLInputElement {
  return el('input', {
    type: 'number', class: 'watts', title,
    min: String(MIN_TARGET_WATTS), max: String(MAX_TARGET_WATTS), step: '5',
  }) as HTMLInputElement;
}

/**
 * Commit a watts field on `change` (Enter or leaving it), never per keystroke,
 * so typing "2" on the way to "250" never reaches the trainer. A refused value
 * is put back by the next render, which shows the target in force; Escape and
 * an empty field call `clear`, when there is one.
 */
function commitWatts(input: HTMLInputElement, set: (watts: number) => boolean, clear?: () => void): void {
  input.addEventListener('change', () => {
    const text = input.value.trim();
    if (text === '') clear?.();
    else set(Number(text));
    input.blur();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    input.value = '';
    clear?.();
    input.blur();
  });
}

/** Show the value in force, unless the rider is typing in the field. */
function showWatts(input: HTMLInputElement, watts: number | undefined): void {
  if (document.activeElement === input) return;
  const text = watts === undefined ? '' : String(watts);
  if (input.value !== text) input.value = text;
}

export class RideView {
  private graph: ProfileGraph;
  private elevation: ElevationGraph;
  private miniMap: MiniMap;
  private tiles = new Map<string, { value: HTMLElement; rows: HTMLElement[]; stripe: HTMLElement; label: HTMLElement; root: HTMLElement }>();
  private segmentNodes: HTMLLIElement[] = [];
  private renderedSegmentIndex = -1;
  private workout: Workout | undefined;
  /** the FTP the block list's watts were written with */
  private labelFtp: number | undefined;
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
  private biasButtons: HTMLButtonElement[] = [];
  private overrideInput!: HTMLInputElement;
  private freeButtons = new Map<FreeTarget, HTMLButtonElement>();
  private gradeControls!: HTMLElement;
  private freePowerControls!: HTMLElement;
  private freePowerInput!: HTMLInputElement;
  private gradeReadout!: HTMLElement;
  private gradeInput!: HTMLInputElement;
  private followLabel!: HTMLElement;
  private followInput!: HTMLInputElement;
  private currentMessage: string | undefined;

  constructor(
    private onFinished: (snapshot: SessionSnapshot) => void,
    /** where files the rider loads are kept; none in some tests */
    private personal?: PersonalLibrary,
  ) {
    this.messageNode = qs('#graph-message');
    this.intervalBar = qs('#interval-bar');
    this.controls = qs('#controls');
    this.workoutMeta = qs('#workout-meta');
    this.segmentList = qs('#segment-list');

    this.graph = new ProfileGraph(qs<HTMLCanvasElement>('#profile'));
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
    settings.on('change', () => {
      this.renderSegmentLabels();
      this.colourSegments();
      this.render(session.snapshot);
    });
    courseStore.on('course', (c) => this.onCourseChanged(c));

    this.bindKeys();
    this.applySidebar(settings.current.showSidebar);
    this.loadBuiltin(LIBRARY[0].id);
    this.onCourseChanged(undefined);
  }

  // ---- construction --------------------------------------------------------

  private buildTiles(): void {
    const host = qs('#metrics');
    clear(host);
    for (const spec of TILES) {
      const stripe = el('div', { class: 'tile-stripe' });
      const value = el('span', { text: '--' });
      const label = el('div', { class: 'tile-label', text: spec.label(session.snapshot) });
      const valueRow = el('div', { class: 'tile-value' }, [value, spec.unit ? el('span', { class: 'tile-unit', text: spec.unit }) : null]);
      // The value on the left, the secondary figures in up to two rows on the
      // right, so neither needs a line of its own under the other.
      const rows = spec.side ? [el('div', { class: 'tile-sub' }), el('div', { class: 'tile-sub' })] : [];
      const body = el('div', { class: 'tile-body' }, [valueRow, rows.length ? el('div', { class: 'tile-side' }, rows) : null]);
      const root = el('div', { class: spec.hero ? 'tile tile-hero' : 'tile' }, [stripe, label, body]);
      host.append(root);
      this.tiles.set(spec.key, { value, rows, stripe, label, root });
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
    this.biasButtons = [
      el('button', { class: 'btn btn-small', text: '−', on: { click: () => session.nudgeBias(-0.01) } }),
      el('button', { class: 'btn btn-small', text: '+', on: { click: () => session.nudgeBias(0.01) } }),
    ];
    this.overrideInput = wattsInput('Hold exactly this many watts until the block ends (Esc or empty to clear)');
    this.overrideInput.dataset.role = 'block-watts';
    commitWatts(this.overrideInput, (watts) => session.setBlockOverride(watts), () => session.setBlockOverride(undefined));
    this.biasGroup = el('div', { class: 'group' }, [
      el('label', { text: 'Bias' }),
      this.biasButtons[0],
      this.biasReadout,
      this.biasButtons[1],
      this.overrideInput,
      el('span', { class: 'unit', text: 'W' }),
    ]);

    this.gradeInput = el('input', { type: 'range', min: '-10', max: '20', step: '0.5', value: '0' }) as HTMLInputElement;
    this.gradeInput.addEventListener('input', () => session.setGrade(Number(this.gradeInput.value)));
    this.gradeReadout = el('div', { class: 'readout', text: '0.0%' });

    this.followInput = el('input', { type: 'checkbox' }) as HTMLInputElement;
    this.followInput.addEventListener('change', () => session.setFollowCourse(this.followInput.checked));
    this.followLabel = el('label', { class: 'check', title: 'Take the gradient from the loaded route instead of the slider' }, [
      this.followInput, el('span', { text: 'Follow route' }),
    ]);

    const freeToggle = el('div', { class: 'toggle' });
    for (const target of ['grade', 'power'] as const) {
      const btn = el('button', {
        text: target === 'grade' ? 'Grade' : 'Watts',
        title: target === 'grade' ? 'Trainer emulates a gradient' : 'Trainer holds the watts you type',
        dataset: { freeTarget: target },
        on: { click: () => session.setFreeTarget(target) },
      });
      this.freeButtons.set(target, btn);
      freeToggle.append(btn);
    }
    this.gradeControls = el('span', { class: 'subgroup' }, [this.gradeInput, this.gradeReadout, this.followLabel]);
    this.freePowerInput = wattsInput('The power to hold while riding free');
    this.freePowerInput.dataset.role = 'free-watts';
    // Clearing the free watts is not a thing: Grade is how to stop holding them.
    commitWatts(this.freePowerInput, (watts) => session.setFreePower(watts));
    this.freePowerControls = el('span', { class: 'subgroup' }, [this.freePowerInput, el('span', { class: 'unit', text: 'W' })]);

    this.gradeGroup = el('div', { class: 'group' }, [
      el('label', { text: 'Free' }), freeToggle, this.gradeControls, this.freePowerControls,
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
        el('button', { class: 'btn btn-small', text: '+30s', on: { click: () => session.seek(30) } }),
        el('button', { class: 'btn btn-small', text: '▶|', title: 'Next block', on: { click: () => session.skipToNextBlock() } }),
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
    this.attachLoader('pick-workout', 'workout-drop', '.zwo,.fit,.xml', (file) => void this.loadFromSource(file, 'file'));
  }

  private buildRoutePanel(): void {
    this.attachLoader('pick-route', 'route-drop', '.gpx,.fit', (file) => void this.loadFromSource(file, 'file'));
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

  /**
   * A built-in workout, by id. Synchronous, unlike every other source, so the
   * ride screen boots with a workout already in place. Returns whether it
   * loaded.
   */
  loadBuiltin(id: string): boolean {
    const entry = LIBRARY.find((e) => e.id === id);
    if (!entry) return false;
    try {
      const workout = parseZwo(entry.zwo, { ftp: settings.current.ftp });
      workout.source = 'builtin';
      rememberEntry(workout, { key: `builtin:${id}`, title: entry.title });
      session.loadWorkout(workout);
      return true;
    } catch (err) {
      toast(`Could not load "${entry.title}": ${(err as Error).message}`, 'error');
      return false;
    }
  }

  /**
   * Loads a workout and/or route from a file, whichever source its bytes came
   * from — a file the rider picked, the catalog, or My library — so every
   * source parses alike. Returns whether anything was loaded; on failure the
   * ride's workout and route are left as they were.
   */
  async loadFromSource(file: File, origin: LoadOrigin, entry?: LoadedEntries): Promise<boolean> {
    try {
      const result = await loadFile(file, { ftp: settings.current.ftp });
      if (result.workout && entry?.workout) rememberEntry(result.workout, entry.workout);
      if (result.workout) {
        session.loadWorkout(result.workout);
        toast(`Loaded "${result.workout.name}" — ${hhmmss(result.workout.duration)}`);
      }
      if (result.track) {
        const course = courseStore.load(result.track);
        if (course && entry?.route) rememberRoute(course, entry.route);
        if (course) {
          toast(`Route "${course.name}" — ${(course.totalDistance / 1000).toFixed(1)} km, ${Math.round(course.totalAscent)} m up`);
        } else {
          toast('Loaded, but this ride has no GPS positions — indoor rides have no route.');
        }
      }
      if (!result.workout && !result.track) {
        toast('Nothing usable in that file.', 'error');
        return false;
      }
      // A file from disk is kept in My library; one that came from there or
      // from the catalog already has a home.
      if (origin === 'file' && this.personal) {
        const kept = await this.personal.keep(file, result);
        // Now it is a My library entry, and can be marked done after the ride.
        if (result.workout && kept.sha256) {
          rememberEntry(result.workout, { key: `mine:${kept.sha256}`, title: kept.workoutTitle ?? result.workout.name, sha256: kept.sha256 });
        }
        if (courseStore.current && result.track && kept.sha256 && courseStore.track === result.track) {
          rememberRoute(courseStore.current, { key: `mine:${kept.sha256}`, title: courseStore.current.name, sha256: kept.sha256 });
        }
        if (kept.outcome === 'unavailable' || kept.outcome === 'failed') {
          toast('Loaded, but it could not be saved to My library — browser storage is unavailable or full.', 'error');
        }
      }
      return true;
    } catch (err) {
      toast(origin === 'file' ? (err as Error).message : `Could not load it: ${(err as Error).message}`, 'error');
      return false;
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
    this.workout = workout;
    this.labelFtp = undefined;
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

    workout.segments.forEach((seg) => {
      const node = el('li', { dataset: { index: String(seg.index) } }, [
        el('div', { class: 'bar' }),
        el('div', { class: 'label' }),
        el('div', { class: 'dur', text: mmss(seg.duration) }),
      ]);
      this.segmentList.append(node);
      this.segmentNodes.push(node);
    });
    this.colourSegments();
    this.renderSegmentLabels();
  }

  /** Colours each block's bar by the rider's power zones, in place. */
  private colourSegments(): void {
    const workout = this.workout;
    if (!workout) return;
    const ftp = effectiveFtp(workout);
    const power = zones().power;
    workout.segments.forEach((seg, i) => {
      const bar = this.segmentNodes[i]?.firstElementChild as HTMLElement | null | undefined;
      if (!bar) return;
      const mid = seg.powerStart === undefined ? undefined : ((seg.powerStart + (seg.powerEnd ?? seg.powerStart)) / 2);
      const color = mid === undefined ? '#7a8694' : zoneForPower(mid * ftp, ftp, power).color;
      bar.style.background = color;
    });
  }

  /** Writes each block's target in watts. Only when the FTP they are worked out
   *  from has changed, and in place, so the list keeps its nodes and classes. */
  private renderSegmentLabels(): void {
    const workout = this.workout;
    if (!workout) return;
    const ftp = effectiveFtp(workout);
    if (ftp === this.labelFtp) return;
    this.labelFtp = ftp;
    workout.segments.forEach((seg, i) => {
      const label = this.segmentNodes[i]?.querySelector<HTMLElement>('.label');
      if (label) setText(label, blockLabel(seg, ftp));
    });
  }

  // ---- rendering -----------------------------------------------------------

  private render(s: SessionSnapshot): void {
    for (const spec of TILES) {
      const tile = this.tiles.get(spec.key);
      if (!tile) continue;
      setText(tile.label, spec.label(s));
      setText(tile.value, spec.value(s));
      const side = spec.side?.(s) ?? [];
      tile.rows.forEach((node, i) => {
        const row = side[i] ?? '';
        if (typeof row === 'string') setText(node, row);
        else setParts(node, row);
        setClass(node, 'has-parts', typeof row !== 'string');
        node.style.display = row.length ? '' : 'none';
      });
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
    const overridden = s.blockOverride !== undefined;
    for (const btn of this.biasButtons) btn.disabled = overridden;
    setClass(this.biasReadout, 'inert', overridden);
    showWatts(this.overrideInput, s.blockOverride);
    // An empty field reads as "following the workout", and says what that is.
    this.overrideInput.placeholder = !overridden && s.targetPower > 0 ? String(s.targetPower) : '';
    for (const [target, btn] of this.freeButtons) setClass(btn, 'on', s.freeTarget === target);
    this.gradeControls.style.display = s.freeTarget === 'grade' ? '' : 'none';
    this.freePowerControls.style.display = s.freeTarget === 'power' ? '' : 'none';
    showWatts(this.freePowerInput, s.freePower);
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
    const ftp = effectiveFtp(s.workout);
    const label = blockLabel(s.segment, ftp);
    setText(flag, free ? 'free' : 'erg');
    setClass(flag, 'free', free);
    // An unnamed FIT step is named after its intensity, which is also its kind.
    setText(now, s.segment.name === s.segment.kind ? label : `${s.segment.kind} · ${label}`);
    setText(countdown, mmss(s.segmentRemaining));
    setText(next, s.nextSegment
      ? `next: ${blockLabel(s.nextSegment, ftp)} (${mmss(s.nextSegment.duration)})`
      : 'last block');
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
