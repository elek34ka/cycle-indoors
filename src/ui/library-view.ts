import { hhmmss, mmss } from '../core/format';
import { settings } from '../core/settings';
import { zoneForRatio } from '../core/zones';
import { CatalogClient, type IndexResult } from '../catalog/client';
import { displayName } from '../catalog/names';
import type { CompactBlock, PlanEntry } from '../catalog/types';
import type { StoredFile } from '../library/db';
import {
  SOURCE_LABELS, builtinWorkouts, catalogPlans, catalogRoutes, catalogWorkouts, mineRoutes, mineWorkouts,
  type EntrySource, type RouteItem, type WorkoutItem,
} from '../library/entries';
import type { PersonalLibrary } from '../library/personal';
import {
  NO_FILTERS, filterRoutes, filterWorkouts, isFiltered, passesDone, tagsOf,
  type DoneFilter, type LibraryFilters, type LibrarySection,
} from '../library/filter';
import type { LoadedEntry } from '../library/loaded';
import { planProgress } from '../library/plans';
import { session } from '../session/session';
import { targetText } from '../workout/targets';
import type { Segment } from '../workout/types';
import { confirmDialog } from './confirm';
import { clear, el, toast } from './dom';
import { routeProfileSvg, workoutProfileSvg } from './library-profile';
import type { LoadOrigin } from './ride-view';

/** What the Library needs from the rest of the app to put an entry on the ride. */
export interface LibraryHost {
  loadBuiltin(id: string): boolean;
  /** `entry` is the Library entry the file is, so a finished ride can offer
   *  to mark it done */
  loadFile(file: File, origin: LoadOrigin, entry?: LoadedEntry): Promise<boolean>;
  showRide(): void;
}

type CatalogState = { status: 'idle' | 'loading' } | { status: 'done'; result: IndexResult };

const SECTIONS: { key: LibrarySection; label: string }[] = [
  { key: 'workouts', label: 'Workouts' },
  { key: 'routes', label: 'Routes' },
  { key: 'plans', label: 'Plans' },
];

/** The sources each section can list. */
const SECTION_SOURCES: Record<LibrarySection, EntrySource[]> = {
  workouts: ['builtin', 'catalog', 'mine'],
  routes: ['catalog', 'mine'],
  plans: ['catalog'],
};


const planMeta = (p: PlanEntry) =>
  `${p.totals.workouts} workouts · ${Math.round(p.totals.duration / 360) / 10} h · TSS ${Math.round(p.totals.tss)}`;
const workoutMeta = (w: WorkoutItem) => `${hhmmss(w.duration)} · TSS ${Math.round(w.tss)} · IF ${w.if.toFixed(2)}`;
const routeMeta = (r: RouteItem) => `${(r.distance / 1000).toFixed(1)} km · ${Math.round(r.ascent)} m up`;

/** A compact block's target as the ride screen writes it: "180–240 W (60–80%)". */
function blockTarget(block: CompactBlock, ftp: number): string {
  if (block[1] === null) return 'Free ride';
  return targetText({ powerStart: block[1], powerEnd: block[2] ?? block[1] } as Segment, ftp) ?? '';
}

/**
 * The Library tab: workouts, routes and plans from every source, searchable
 * and filterable, each loadable onto the ride with one press. The catalog is
 * fetched when the tab opens, never at boot; without it the built-in workouts
 * are still here.
 */
export class LibraryView {
  private catalog: CatalogState = { status: 'idle' };
  private selected: Partial<Record<LibrarySection, string>> = {};
  /** the entry whose file is being fetched, if any */
  private loadingKey: string | undefined;
  /** My library's files; `mineAvailable` is unknown until the store opens */
  private mine: StoredFile[] = [];
  private mineAvailable: boolean | undefined;
  /** done marks by entry key → when (unix ms) */
  private done = new Map<string, number>();
  private followedPlan: string | undefined;

  private sectionButtons = new Map<LibrarySection, HTMLButtonElement>();
  private statusNode: HTMLElement;
  private mineNode: HTMLElement;
  private noticeNode: HTMLElement;
  private upNextNode: HTMLElement;
  private filtersNode: HTMLElement;
  private listNode: HTMLElement;
  private detailNode: HTMLElement;
  private tagSelect: HTMLSelectElement | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly host: LibraryHost,
    private readonly client: CatalogClient = new CatalogClient(),
    private readonly personal?: PersonalLibrary,
  ) {
    clear(root);
    const toggle = el('div', { class: 'toggle lib-sections' });
    for (const { key, label } of SECTIONS) {
      const button = el('button', { type: 'button', text: label, dataset: { section: key }, on: { click: () => this.setSection(key) } });
      this.sectionButtons.set(key, button);
      toggle.append(button);
    }
    this.statusNode = el('div', { class: 'lib-status' });
    this.mineNode = el('div', { class: 'lib-status error lib-mine-status', attrs: { hidden: '' } });
    this.noticeNode = el('div', { class: 'lib-notice', attrs: { role: 'status' } });
    this.upNextNode = el('div', { class: 'up-next lib-up-next', attrs: { hidden: '' } });
    this.filtersNode = el('div', { class: 'lib-filters' });
    this.listNode = el('ul', { class: 'lib-list' });
    this.detailNode = el('div', { class: 'lib-detail' });
    root.append(
      el('div', { class: 'lib-head' }, [toggle, this.statusNode, this.mineNode]),
      this.noticeNode,
      this.upNextNode,
      this.filtersNode,
      el('div', { class: 'lib-body' }, [this.listNode, this.detailNode]),
    );

    session.on('state', () => this.renderRideState());
    settings.on('change', () => this.renderContent());
    personal?.on('change', () => void this.refreshMine());
    this.renderFilters();
    this.renderStatus();
    this.renderContent();
    void this.refreshMine();
  }

  private get section(): LibrarySection { return settings.current.librarySection; }
  private get filters(): LibraryFilters { return settings.current.libraryFilters; }
  private get index() { return this.catalog.status === 'done' && this.catalog.result.ok ? this.catalog.result.index : undefined; }

  /** Called whenever the tab is shown: fetches a fresh copy of the catalog. */
  open(section?: LibrarySection): void {
    if (section) this.setSection(section);
    void this.refreshCatalog();
    void this.refreshMine();
  }

  setSection(section: LibrarySection): void {
    if (section !== this.section) settings.patch({ librarySection: section });
    this.renderFilters();
    this.renderContent();
  }

  /** `fresh` when the tab opens; not when Up next just needs the plan, so a
   *  copy already fetched is reused. */
  private async refreshCatalog(fresh = true): Promise<void> {
    if (this.catalog.status === 'loading') return;
    this.catalog = { status: 'loading' };
    this.renderStatus();
    this.renderUpNext();
    const result = await this.client.loadIndex(fresh);
    this.catalog = { status: 'done', result };
    this.renderStatus();
    this.refreshTagOptions();
    this.renderContent();
  }

  private async refreshMine(): Promise<void> {
    if (!this.personal) return;
    this.mineAvailable = await this.personal.available();
    this.mine = await this.personal.entries();
    this.done = await this.personal.doneMarks();
    this.followedPlan = await this.personal.followed();
    // Up next needs the followed plan from the catalog. Fetched in the
    // background, and only when a plan is followed: boot never waits on it.
    if (this.followedPlan && this.catalog.status === 'idle') void this.refreshCatalog(false);
    this.mineNode.hidden = this.mineAvailable;
    this.mineNode.textContent = this.mineAvailable ? ''
      : 'My library is unavailable — this browser is not letting the app store files. Files you load still work, but are not kept.';
    this.refreshTagOptions();
    this.renderContent();
  }

  // ---- entries -------------------------------------------------------------

  private workouts(): WorkoutItem[] {
    return [...builtinWorkouts(), ...catalogWorkouts(this.index), ...mineWorkouts(this.mine)];
  }
  private routes(): RouteItem[] { return [...catalogRoutes(this.index), ...mineRoutes(this.mine)]; }
  private plans(): PlanEntry[] { return catalogPlans(this.index); }

  private isDone = (key: string) => this.done.has(key);

  /** Marks are saved in the browser; without storage they cannot be. */
  private get canMark(): boolean { return this.personal !== undefined && this.mineAvailable === true; }

  private rideLocked(): boolean {
    const state = session.snapshot.state;
    return state === 'running' || state === 'paused';
  }

  // ---- rendering -----------------------------------------------------------

  private renderStatus(): void {
    clear(this.statusNode);
    this.statusNode.classList.remove('error');
    const c = this.catalog;
    if (c.status !== 'done') {
      this.statusNode.append(el('span', { text: 'Loading the catalog…' }));
      return;
    }
    if (c.result.ok) {
      const built = new Date(c.result.index.builtAt);
      this.statusNode.append(el('span', {
        text: `Catalog updated ${Number.isNaN(built.getTime()) ? '—' : built.toLocaleDateString()}`,
      }));
      return;
    }
    if (c.result.reason === 'unconfigured') {
      this.statusNode.append(el('span', { text: 'No catalog is set up — built-in workouts only.' }));
      return;
    }
    this.statusNode.classList.add('error');
    this.statusNode.append(
      el('span', { class: 'lib-status-message', text: `${c.result.message}. Built-in workouts are still here.` }),
      el('button', { type: 'button', class: 'btn btn-small', text: 'Retry', on: { click: () => void this.refreshCatalog() } }),
    );
  }

  private renderFilters(): void {
    clear(this.filtersNode);
    this.tagSelect = undefined;
    for (const [key, button] of this.sectionButtons) button.classList.toggle('on', key === this.section);
    const f = this.filters;
    const patch = (partial: Partial<LibraryFilters>) => settings.patch({ libraryFilters: { ...this.filters, ...partial } });

    const search = el('input', {
      type: 'text', class: 'lib-search', value: f.search,
      placeholder: this.section === 'routes' ? 'Search name or tag' : 'Search title, author or tag',
      attrs: { 'aria-label': 'Search', 'data-filter': 'search' },
    }) as HTMLInputElement;
    search.addEventListener('input', () => patch({ search: search.value }));
    this.filtersNode.append(el('div', { class: 'field lib-search-field' }, [el('label', { text: 'Search' }), search]));
    const doneSelect = el('select', { class: 'select', attrs: { 'data-filter': 'done', 'aria-label': 'Done' } }) as HTMLSelectElement;
    for (const [value, text] of [['any', 'Done or not'], ['done', 'Done'], ['todo', 'Not done']]) {
      doneSelect.append(el('option', { value, text }));
    }
    doneSelect.value = f.done;
    doneSelect.addEventListener('change', () => patch({ done: doneSelect.value as DoneFilter }));
    const doneField = el('div', { class: 'field' }, [el('label', { text: 'Done' }), doneSelect]);
    if (this.section === 'plans') { this.filtersNode.append(doneField); return; }

    const source = el('select', { class: 'select', attrs: { 'data-filter': 'source', 'aria-label': 'Source' } }) as HTMLSelectElement;
    source.append(el('option', { value: 'all', text: 'All sources' }));
    for (const s of SECTION_SOURCES[this.section]) source.append(el('option', { value: s, text: SOURCE_LABELS[s] }));
    source.value = SECTION_SOURCES[this.section].includes(f.source as EntrySource) ? f.source : 'all';
    source.addEventListener('change', () => patch({ source: source.value as LibraryFilters['source'] }));
    this.filtersNode.append(el('div', { class: 'field' }, [el('label', { text: 'Source' }), source]));

    this.tagSelect = el('select', { class: 'select', attrs: { 'data-filter': 'tag', 'aria-label': 'Tag' } }) as HTMLSelectElement;
    this.tagSelect.addEventListener('change', () => patch({ tag: this.tagSelect!.value }));
    this.filtersNode.append(el('div', { class: 'field' }, [el('label', { text: 'Tag' }), this.tagSelect]));
    this.refreshTagOptions();

    const range = (label: string, minKey: keyof LibraryFilters, maxKey: keyof LibraryFilters) => {
      const input = (key: keyof LibraryFilters, placeholder: string) => {
        const value = f[key] as number | null;
        const node = el('input', {
          type: 'number', min: '0', placeholder, value: value === null ? '' : String(value),
          attrs: { 'data-filter': key, 'aria-label': `${label} ${placeholder}` },
        }) as HTMLInputElement;
        node.addEventListener('input', () => {
          const n = node.value.trim() === '' ? null : Number(node.value);
          patch({ [key]: n === null || Number.isNaN(n) ? null : n });
        });
        return node;
      };
      this.filtersNode.append(el('div', { class: 'field' }, [
        el('label', { text: label }),
        el('div', { class: 'lib-range' }, [input(minKey, 'min'), el('span', { text: '–' }), input(maxKey, 'max')]),
      ]));
    };
    if (this.section === 'workouts') {
      range('Minutes', 'minMinutes', 'maxMinutes');
      this.filtersNode.append(doneField);
    } else {
      range('Distance km', 'minKm', 'maxKm');
      range('Ascent m', 'minAscent', 'maxAscent');
    }
  }

  /** Tag choices follow the entries in hand; a remembered tag stays selectable
   *  until the catalog that has it arrives. */
  private refreshTagOptions(): void {
    const select = this.tagSelect;
    if (!select) return;
    const tags = tagsOf(this.section === 'workouts' ? this.workouts() : this.routes());
    const current = this.filters.tag;
    if (current && !tags.includes(current)) tags.unshift(current);
    clear(select);
    select.append(el('option', { value: '', text: 'Any tag' }));
    for (const tag of tags) select.append(el('option', { value: tag, text: tag }));
    select.value = current;
  }

  private renderContent(): void {
    this.renderList();
    this.renderDetail();
    this.renderUpNext();
    this.renderRideState();
  }

  private renderList(): void {
    clear(this.listNode);
    const f = this.filters;
    if (this.section === 'workouts') {
      const all = this.workouts();
      const shown = filterWorkouts(all, f, this.isDone);
      for (const w of shown) this.listNode.append(this.workoutRow(w));
      if (shown.length === 0) this.listNode.append(this.emptyRow(all.length, 'workouts'));
    } else if (this.section === 'routes') {
      const all = this.routes();
      const shown = filterRoutes(all, f);
      for (const r of shown) this.listNode.append(this.routeRow(r));
      if (shown.length === 0) this.listNode.append(this.emptyRow(all.length, 'routes'));
    } else {
      const all = this.plans();
      const words = f.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const titles = new Map(catalogWorkouts(this.index).map((w) => [w.id, w.title]));
      // A plan matches on its own title or any of its workouts' titles.
      const text = (p: PlanEntry) => [p.title, ...p.workouts.map((id) => titles.get(id) ?? '')].join('\n').toLowerCase();
      const shown = all.filter((p) => words.every((word) => text(p).includes(word)));
      // The plan being followed comes first; the rest keep the catalog's order.
      shown.sort((a, b) => Number(b.id === this.followedPlan) - Number(a.id === this.followedPlan));
      for (const p of shown) this.listNode.append(this.planRow(p));
      if (shown.length === 0) this.listNode.append(this.emptyRow(all.length, 'plans'));
    }
  }

  private emptyRow(total: number, noun: string): HTMLElement {
    if (total > 0 && isFiltered(this.filters, this.section)) {
      return el('li', { class: 'empty lib-empty' }, [
        el('div', { text: `No ${noun} match these filters.` }),
        el('button', {
          type: 'button', class: 'btn btn-small', text: 'Clear filters',
          on: { click: () => { settings.patch({ libraryFilters: NO_FILTERS }); this.renderFilters(); } },
        }),
      ]);
    }
    const why = this.catalog.status === 'done' && !this.catalog.result.ok ? ' The catalog is not available.' : '';
    return el('li', { class: 'empty lib-empty', text: `No ${noun} yet.${why}` });
  }

  private tags(source: EntrySource, tags: string[], doneKey?: string): HTMLElement {
    return el('div', { class: 'lib-tags' }, [
      doneKey ? this.doneBadge(doneKey) : null,
      el('span', { class: 'lib-source', text: SOURCE_LABELS[source] }),
      ...tags.map((t) => el('span', { class: 'lib-tag', text: t })),
    ]);
  }

  /** "Done 12 Oct" on a done workout, nothing otherwise. */
  private doneBadge(key: string): HTMLElement | null {
    const at = this.done.get(key);
    if (at === undefined) return null;
    const day = new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    return el('span', { class: 'lib-done', text: `Done ${day}`, title: `Marked done on ${new Date(at).toLocaleDateString()}` });
  }

  /** Mark as done / not done, disabled with the reason when it cannot save. */
  private doneToggle(key: string, small = false): HTMLButtonElement {
    const done = this.done.has(key);
    const button = el('button', {
      type: 'button', class: `btn lib-done-toggle${small ? ' btn-small' : ''}`, dataset: { key },
      text: small ? (done ? 'Undo done' : 'Done') : done ? 'Mark as not done' : 'Mark as done',
      on: { click: (e) => { e.stopPropagation(); void this.toggleDone(key); } },
    }) as HTMLButtonElement;
    if (!this.canMark) {
      button.disabled = true;
      button.title = 'Done marks cannot be saved in this browser';
    }
    return button;
  }

  private async toggleDone(key: string): Promise<void> {
    if (!this.canMark) return;
    try {
      await this.personal!.setDone(key, !this.done.has(key));
    } catch (err) {
      toast(`Could not save the done mark: ${(err as Error).message}`, 'error');
    }
  }

  private row(key: string, profile: Element, title: string, meta: string, tags: HTMLElement, ride?: () => void): HTMLElement {
    const li = el('li', {
      class: `lib-item${this.selected[this.section] === key ? ' selected' : ''}`,
      dataset: { key },
      on: { click: () => { this.selected[this.section] = key; this.renderContent(); } },
    }, [
      profile,
      el('div', { class: 'lib-item-main' }, [
        el('div', { class: 'lib-title', text: title, title }),
        el('div', { class: 'lib-meta', text: meta }),
        tags,
      ]),
    ]);
    if (ride) li.append(this.rideButton(key, ride));
    return li;
  }

  private rideButton(key: string, ride: () => void, large = false): HTMLButtonElement {
    return el('button', {
      type: 'button', class: `btn btn-primary lib-ride${large ? '' : ' btn-small'}`, text: 'Ride', dataset: { key },
      on: { click: (e) => { e.stopPropagation(); ride(); } },
    });
  }

  private workoutRow(w: WorkoutItem): HTMLElement {
    return this.row(w.key, workoutProfileSvg(w.blocks), w.title, workoutMeta(w), this.tags(w.source, w.tags, w.key), () => void this.ride(w, w.title));
  }

  private routeRow(r: RouteItem): HTMLElement {
    return this.row(r.key, routeProfileSvg(r.profile), r.name, routeMeta(r), this.tags(r.source, r.tags), () => void this.ride(r, r.name));
  }

  private planRow(p: PlanEntry): HTMLElement {
    const t = p.totals;
    const profile = el('div', { class: 'lib-plan-weeks' }, [
      el('strong', { text: String(t.workouts) }), el('span', { text: t.workouts === 1 ? 'workout' : 'workouts' }),
    ]);
    const progress = planProgress(p, (id) => this.isDone(`catalog:${id}`));
    const following = this.followedPlan === p.id ? ' · following' : '';
    return this.row(`catalog:${p.id}`, profile, p.title, `${planMeta(p)} · ${progress.done} of ${progress.total} done${following}`,
      this.tags('catalog', []));
  }

  private renderDetail(): void {
    clear(this.detailNode);
    const key = this.selected[this.section];
    if (this.section === 'workouts') {
      const w = this.workouts().find((x) => x.key === key);
      if (w) { this.workoutDetail(w); return; }
    } else if (this.section === 'routes') {
      const r = this.routes().find((x) => x.key === key);
      if (r) { this.routeDetail(r); return; }
    } else {
      const p = this.plans().find((x) => `catalog:${x.id}` === key);
      if (p) { this.planDetail(p); return; }
    }
    const noun = this.section === 'workouts' ? 'a workout' : this.section === 'routes' ? 'a route' : 'a plan';
    this.detailNode.append(el('div', { class: 'empty', text: `Select ${noun} to see it here.` }));
  }

  /** The detail pane's contents; optional parts come through as null. */
  private fillDetail(...nodes: (Node | null)[]): void {
    for (const node of nodes) if (node) this.detailNode.append(node);
  }

  private workoutDetail(w: WorkoutItem): void {
    const ftp = settings.current.ftp;
    const blocks = el('ol', { class: 'lib-blocks' });
    for (const b of w.blocks) {
      const color = b[1] === null ? 'var(--text-faint)' : zoneForRatio(((b[1] ?? 0) + (b[2] ?? b[1] ?? 0)) / 2).color;
      blocks.append(el('li', {}, [
        el('span', { class: 'bar', attrs: { style: `background:${color}` } }),
        el('span', { text: mmss(b[0]) }),
        el('span', { text: blockTarget(b, ftp) }),
      ]));
    }
    this.fillDetail(
      el('h2', { text: w.title }),
      el('div', { class: 'lib-meta', text: workoutMeta(w) }),
      w.author ? el('div', { class: 'lib-author', text: `by ${w.author}` }) : null,
      this.tags(w.source, w.tags, w.key),
      workoutProfileSvg(w.blocks, 600, 96, 'lib-profile-large'),
      this.actions(w, w.title),
      // textContent, never innerHTML: descriptions come from other people's files
      w.description ? el('p', { class: 'lib-desc', text: w.description }) : null,
      el('div', { class: 'panel-head', text: `Blocks at ${ftp} W FTP` }),
      blocks,
    );
  }

  /** Ride, and for My library entries, Remove. */
  private actions(item: WorkoutItem | RouteItem, title: string): HTMLElement {
    const row = el('div', { class: 'lib-actions' }, [this.rideButton(item.key, () => void this.ride(item, title), true)]);
    // Routes are not workouts: only workouts are marked done.
    if ('title' in item) row.append(this.doneToggle(item.key));
    if ('title' in item && !this.canMark) {
      row.append(el('span', { class: 'lib-done-note', text: 'Done marks cannot be saved in this browser.' }));
    }
    if (item.source === 'mine') {
      row.append(el('button', {
        type: 'button', class: 'btn btn-danger lib-remove', text: 'Remove from My library',
        on: { click: () => void this.remove(item, title) },
      }));
    }
    return row;
  }

  private routeDetail(r: RouteItem): void {
    this.fillDetail(
      el('h2', { text: r.name }),
      el('div', { class: 'lib-meta', text: `${routeMeta(r)} · starts ${r.start[0].toFixed(4)}, ${r.start[1].toFixed(4)}` }),
      this.tags(r.source, r.tags),
      routeProfileSvg(r.profile, 600, 96, 'lib-profile-large'),
      this.actions(r, r.name),
    );
  }

  /** The plan's workouts in order, under a heading wherever the sub-folder
   *  changes. Each Ride loads the workout itself, the same entry Workouts
   *  lists. */
  private planDetail(p: PlanEntry): void {
    const byId = new Map(catalogWorkouts(this.index).map((w) => [w.id, w]));
    // Under its sub-folder heading a workout needs no `Week 1 ·` in front.
    const plainTitle = new Map((this.index?.workouts ?? []).map((w) => [w.id, w.title]));
    const groups = el('div', { class: 'lib-plan' });
    let list: HTMLElement | undefined;
    let group: string | undefined;
    const f = this.filters;
    for (const id of p.workouts) {
      const w = byId.get(id);
      if (!w || !passesDone(f, this.isDone(w.key))) continue;
      const g = w.group ?? '';
      if (!list || g !== group) {
        group = g;
        if (g) groups.append(el('div', { class: 'panel-head lib-plan-group', text: displayName(g) }));
        list = el('ol', { class: 'lib-plan-workouts' });
        groups.append(list);
      }
      list.append(el('li', { dataset: { key: w.key }, class: this.isDone(w.key) ? 'done' : '' }, [
        el('span', { class: 'lib-plan-title', text: plainTitle.get(id) ?? w.title, title: w.title }),
        el('span', { class: 'lib-meta', text: `${hhmmss(w.duration)} · TSS ${Math.round(w.tss)}` }),
        this.doneBadge(w.key) ?? el('span'),
        this.doneToggle(w.key, true),
        this.rideButton(w.key, () => void this.ride(w, w.title)),
      ]));
    }
    const progress = planProgress(p, (id) => this.isDone(`catalog:${id}`));
    const following = this.followedPlan === p.id;
    const follow = el('button', {
      type: 'button', class: `btn ${following ? '' : 'btn-primary'} lib-follow`,
      text: following ? 'Stop following' : 'Follow this plan',
      on: { click: () => void this.follow(following ? undefined : p.id) },
    }) as HTMLButtonElement;
    if (!this.canMark) {
      follow.disabled = true;
      follow.title = 'The followed plan cannot be saved in this browser';
    }
    this.fillDetail(
      el('h2', { text: p.title }),
      el('div', { class: 'lib-meta', text: `${planMeta(p)} · ${progress.done} of ${progress.total} done` }),
      el('div', { class: 'lib-actions' }, [follow]),
      groups.childElementCount > 0 ? groups : el('div', { class: 'empty', text: 'No workouts in this plan match the done filter.' }),
    );
  }

  private async follow(planId: string | undefined): Promise<void> {
    try {
      await this.personal?.follow(planId);
    } catch (err) {
      toast(`Could not save the followed plan: ${(err as Error).message}`, 'error');
    }
  }

  /**
   * Up next for the followed plan, in the Plans section and on the ride
   * screen's Workout panel: its first workout not done, with Ride, or why
   * there is none.
   */
  private renderUpNext(): void {
    const panel = document.getElementById('up-next');
    const targets = [this.upNextNode, ...(panel ? [panel] : [])];
    for (const target of targets) {
      clear(target);
      target.hidden = this.followedPlan === undefined || (target === this.upNextNode && this.section !== 'plans');
    }
    const planId = this.followedPlan;
    if (!planId) return;
    for (const target of targets) target.append(...this.upNextContent(planId));
  }

  private upNextContent(planId: string): Node[] {
    const line = (text: string, cls = '') => [el('span', { class: `up-next-text ${cls}`.trim(), text })];
    if (this.catalog.status !== 'done') return line('Up next: loading the plan…');
    const index = this.index;
    if (!index) return line('Up next is unavailable — the catalog cannot be reached.', 'error');
    const plan = index.plans.find((p) => p.id === planId);
    if (!plan) return line(`The plan you follow, "${displayName(planId.replace(/^plan:/, ''))}", is no longer published.`, 'error');
    const progress = planProgress(plan, (id) => this.isDone(`catalog:${id}`));
    if (progress.complete) return line(`${plan.title} is complete — all ${progress.total} workouts done.`);
    const w = catalogWorkouts(index).find((x) => x.id === progress.next);
    if (!w) return line(`Up next is unavailable in ${plan.title}.`, 'error');
    return [
      el('span', { class: 'up-next-text' }, [
        el('span', { class: 'up-next-label', text: `Up next in ${plan.title} (${progress.done + 1} of ${progress.total})` }),
        el('strong', { class: 'up-next-title', text: w.title }),
        el('span', { class: 'lib-meta', text: `${hhmmss(w.duration)} · TSS ${Math.round(w.tss)}` }),
      ]),
      this.rideButton(w.key, () => void this.ride(w, w.title)),
    ];
  }

  /** Ride buttons follow the session: no loading over a ride in progress. */
  private renderRideState(): void {
    const locked = this.rideLocked();
    this.noticeNode.textContent = locked ? 'A ride is in progress. Finish it to load a different workout or route.' : '';
    this.noticeNode.hidden = !locked;
    const panel = document.getElementById('up-next');
    const buttons = [
      ...Array.from(this.root.querySelectorAll<HTMLButtonElement>('.lib-ride')),
      ...Array.from(panel?.querySelectorAll<HTMLButtonElement>('.lib-ride') ?? []),
    ];
    for (const button of buttons) {
      const loading = button.dataset.key === this.loadingKey;
      button.disabled = locked || this.loadingKey !== undefined;
      button.textContent = loading ? 'Loading…' : 'Ride';
      button.title = locked ? 'A ride is in progress' : '';
    }
  }

  // ---- loading -------------------------------------------------------------

  private async ride(item: WorkoutItem | RouteItem, title: string): Promise<void> {
    if (this.rideLocked() || this.loadingKey !== undefined) return;
    if (item.source === 'builtin') {
      if (this.host.loadBuiltin(item.id)) this.host.showRide();
      return;
    }
    if (!item.fileName) return;
    this.loadingKey = item.key;
    this.renderRideState();
    try {
      let bytes: Uint8Array;
      if (item.source === 'mine') {
        const kept = await this.personal?.file(item.id);
        if (!kept) throw new Error('it is no longer in My library');
        bytes = kept.bytes;
      } else {
        if (!item.file) return;
        bytes = await this.client.fetchFile(item.file);
      }
      // A ride may have started while the file was on its way.
      if (this.rideLocked()) throw new Error('a ride started in the meantime');
      const loaded = await this.host.loadFile(new File([bytes as BlobPart], item.fileName), item.source === 'mine' ? 'mine' : 'catalog',
        'title' in item ? { key: item.key, title } : undefined);
      if (loaded && item.source === 'mine') void this.personal?.used(item.id);
      if (loaded) this.host.showRide();
    } catch (err) {
      toast(`Could not load "${title}": ${(err as Error).message}`, 'error');
    } finally {
      this.loadingKey = undefined;
      this.renderRideState();
    }
  }

  /** Forgets a kept file. Whatever is loaded on the ride stays loaded. */
  private async remove(item: WorkoutItem | RouteItem, title: string): Promise<void> {
    const both = this.mine.find((f) => f.sha256 === item.id);
    const confirmed = await confirmDialog({
      title: 'Remove from My library?',
      message: `"${title}" will no longer be kept in this browser`
        + `${both?.workout && both.route ? ', as a workout or as a route' : ''}. `
        + 'The file on your computer is not touched, and a ride that has it loaded keeps it.',
      confirmText: 'Remove',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await this.personal?.remove(item.id);
      delete this.selected[this.section];
      this.renderContent();
    } catch (err) {
      toast(`Could not remove it: ${(err as Error).message}`, 'error');
    }
  }
}
