import { settings, zoneBoundsFromPercent, type Settings } from '../core/settings';
import { BOUND_LIMITS, boundsProblem, riderZones, type Zone, type ZoneKind } from '../core/zones';
import { el, setText, toast } from './dom';

/** One zone as the editor shows it: its range in % and in watts or bpm. */
export interface ZoneRow {
  id: number;
  label: string;
  color: string;
  /** % of the reference, to 0.1, trailing zeros dropped: "55", "78.4" */
  lowerPct: string;
  /** absent on the top zone, which has no upper bound */
  upperPct?: string;
  /** watts or bpm, rounded */
  lower: number;
  upper?: number;
  /** "55–75 % · 110–150 W", or "above 150 % · 300 W" for the top zone */
  range: string;
}

/** A fraction as the editor writes it in %: 0.784 → "78.4", 0.75 → "75". */
export const percentText = (fraction: number): string => String(Math.round(fraction * 1000) / 10);

/**
 * The rows the editor shows for `zones` against `reference` (FTP in W or max
 * HR in bpm). Pure, so the suite checks the numbers rather than the DOM.
 */
export function zoneRows(zones: readonly Zone[], reference: number, unit: string): ZoneRow[] {
  const raw = (fraction: number) => Math.round(fraction * reference);
  return zones.map((z, i) => {
    const from = i === 0 ? 0 : zones[i - 1].max;
    const top = !Number.isFinite(z.max);
    const lowerPct = percentText(from);
    const row: ZoneRow = { id: z.id, label: z.label, color: z.color, lowerPct, lower: raw(from), range: '' };
    if (top) {
      row.range = `above ${lowerPct} % · ${row.lower} ${unit}`;
    } else {
      row.upperPct = percentText(z.max);
      row.upper = raw(z.max);
      row.range = `${lowerPct}–${row.upperPct} % · ${row.lower}–${row.upper} ${unit}`;
    }
    return row;
  });
}

interface TableSpec {
  kind: ZoneKind;
  title: string;
  key: 'powerZoneBounds' | 'hrZoneBounds';
  unit: string;
  of: string;
  reference: (s: Readonly<Settings>) => number;
}

const TABLES: TableSpec[] = [
  { kind: 'power', title: 'Power zones', key: 'powerZoneBounds', unit: 'W', of: 'FTP', reference: (s) => s.ftp },
  { kind: 'hr', title: 'Heart-rate zones', key: 'hrZoneBounds', unit: 'bpm', of: 'max HR', reference: (s) => s.hrMax },
];

const zonesOf = (kind: ZoneKind, s: Readonly<Settings>): Zone[] => riderZones(s)[kind];

/** Why `percent` cannot end zone `index` (0-based) given the others, or undefined when it can. */
function editProblem(spec: TableSpec, index: number, percent: number): string | undefined {
  const name = `Z${index + 1}`;
  if (!Number.isFinite(percent)) return `${name} must end at a number`;
  const current = zonesOf(spec.kind, settings.current);
  const bounds = current.slice(0, -1).map((z) => z.max);
  const percents = bounds.map((b) => b * 100);
  percents[index] = percent;
  const candidate = zoneBoundsFromPercent(spec.kind, percents);
  if (!boundsProblem(spec.kind, candidate ?? percents.map((p) => p / 100))) return undefined;
  const limits = BOUND_LIMITS[spec.kind];
  const low = index > 0 ? bounds[index - 1] : limits.min;
  const high = index < bounds.length - 1 ? bounds[index + 1] : limits.max;
  return `${name} must end between ${percentText(low)} % and ${percentText(high)} % of ${spec.of}`;
}

/** A zone set's Formula/Custom tag, kept in step with the settings. */
function setTag(tag: HTMLElement, spec: TableSpec, s: Readonly<Settings>): boolean {
  const custom = s[spec.key] !== null;
  setText(tag, custom ? 'Custom' : 'Formula');
  tag.classList.toggle('custom', custom);
  return custom;
}

/** One table: a row per zone, an upper-bound field on every zone but the top one. */
function buildTable(spec: TableSpec): { head: HTMLElement[]; rows: HTMLElement; update: () => void } {
  const tag = el('span', { class: 'zone-tag' });
  const reset = el('button', {
    class: 'btn zone-reset',
    text: 'Reset to formula',
    on: { click: () => settings.patch({ [spec.key]: null } as Partial<Settings>) },
  }) as HTMLButtonElement;

  const rowsHost = el('div', { class: 'zone-rows' });
  const parts = zonesOf(spec.kind, settings.current).map((z, i, all) => {
    const swatch = el('span', { class: 'zone-swatch' });
    swatch.style.background = z.color;
    const top = i === all.length - 1;
    const input = top ? undefined : el('input', {
      type: 'number',
      step: '0.1',
      min: String(BOUND_LIMITS[spec.kind].min * 100),
      max: String(BOUND_LIMITS[spec.kind].max * 100),
      attrs: { 'aria-label': `Z${z.id} ${z.label}: upper bound, % of ${spec.of}` },
    }) as HTMLInputElement;
    const range = el('span', { class: 'zone-range' });
    input?.addEventListener('change', () => {
      const text = input.value.trim();
      const percent = text === '' ? NaN : Number(text);
      const problem = editProblem(spec, i, percent);
      if (problem) {
        update();
        toast(problem, 'error');
        return;
      }
      const percents = zonesOf(spec.kind, settings.current).slice(0, -1).map((zone) => zone.max * 100);
      percents[i] = percent;
      settings.patch({ [spec.key]: zoneBoundsFromPercent(spec.kind, percents) } as Partial<Settings>);
    });
    rowsHost.append(el('div', { class: 'zone-edit-row', dataset: { zone: String(z.id) } }, [
      swatch,
      el('span', { class: 'zone-name', text: `Z${z.id} ${z.label}` }),
      input ?? el('span', { class: 'zone-open', text: '—' }),
      range,
    ]));
    return { input, range };
  });

  const update = () => {
    const s = settings.current;
    const rows = zoneRows(zonesOf(spec.kind, s), spec.reference(s), spec.unit);
    rows.forEach((row, i) => {
      const { input, range } = parts[i];
      if (input && row.upperPct !== undefined) input.value = row.upperPct;
      setText(range, row.range);
    });
    reset.hidden = !setTag(tag, spec, s);
  };

  return { head: [tag, reset], rows: rowsHost, update };
}

/**
 * A pop-up holding one zone set's table. Edits save as each field is left,
 * like every other setting; Done, Escape or a click on the backdrop closes it.
 */
export function openZoneDialog(kind: ZoneKind): void {
  const spec = TABLES.find((t) => t.kind === kind)!;
  document.querySelector(`.zone-dialog[data-kind="${kind}"]`)?.remove();
  const table = buildTable(spec);
  table.update();
  const unsubscribe = settings.on('change', table.update);

  const overlay = el('div', { class: 'overlay zone-dialog', dataset: { kind } });
  const close = () => {
    unsubscribe();
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  };
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });

  overlay.append(el('div', { class: 'summary-card zone-card', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': spec.title } }, [
    el('div', { class: 'zone-table-head' }, [el('h2', { text: spec.title }), ...table.head]),
    el('p', { class: 'hint', text: `Each zone ends at the % of ${spec.of} you set, and the next starts there.` }),
    table.rows,
    el('div', { class: 'summary-actions' }, [
      el('button', { class: 'btn btn-primary zone-done', text: 'Done', on: { click: close } }),
    ]),
  ]));
  document.addEventListener('keydown', onKey, true);
  (document.getElementById('app') ?? document.body).append(overlay);
  overlay.querySelector<HTMLInputElement>('input')?.focus();
}

/**
 * The Training zones section of Settings: whether each zone set is the
 * formula's or the rider's own, and a button that opens it in a pop-up, so the
 * tables do not take up the page. Follows every settings change, so Reset to
 * defaults or a restored backup shows at once.
 */
export function buildZoneEditor(): HTMLElement {
  const lines = TABLES.map((spec) => {
    const tag = el('span', { class: 'zone-tag' });
    const button = el('button', {
      class: 'btn zone-edit',
      text: spec.kind === 'power' ? 'Edit power zones' : 'Edit heart-rate zones',
      dataset: { kind: spec.kind },
      on: { click: () => openZoneDialog(spec.kind) },
    });
    const line = el('div', { class: 'zone-line', dataset: { kind: spec.kind } }, [
      el('span', { class: 'zone-line-title', text: spec.title }), tag, button,
    ]);
    return { line, update: () => setTag(tag, spec, settings.current) };
  });
  const update = () => lines.forEach((l) => l.update());
  update();
  settings.on('change', update);
  return el('section', { class: 'zone-editor' }, [
    el('h2', { text: 'Training zones' }),
    el('p', {
      class: 'hint',
      text: 'The ride screen, the summary and Strava use these zones; the Library keeps the standard ones.',
    }),
    ...lines.map((l) => l.line),
  ]);
}
