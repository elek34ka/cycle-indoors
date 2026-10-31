import type { ZoneTime } from '../session/metrics';
import { hhmmss } from '../core/format';
import { drawWorkoutGraph, wholeRideDomain, type GraphView } from './profile-graph';
import { drawElevationProfile, type ElevationView } from './elevation-graph';
import { subText, type SummaryValue } from './summary-values';

/**
 * The summary as two PNG images: the ride graph, and a card of every number.
 * Each is laid out by a pure function (sizes, rectangles, strings), which the
 * suite checks, then painted onto a detached canvas of a fixed size, so the
 * window the summary is open in changes nothing.
 */

/** The app's palette, as the images have no stylesheet. */
const COLOURS = {
  bg: '#0b0e13',
  panel: '#161c26',
  raised: '#131821',
  line: '#1d2430',
  text: '#e7ecf3',
  dim: '#93a1b4',
  faint: '#5d6b7e',
  track: '#121823',
};
const SANS = '-apple-system, system-ui, "Segoe UI", sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export interface Rect { x: number; y: number; w: number; h: number; }

/** What a card or band says about the ride above its numbers. */
export interface ImageHeader {
  title: string;
  /** date · duration · FTP */
  subtitle: string;
  route?: string;
}

// ---------------------------------------------------------------------------
// Graph image

/** The graph is drawn at half size and scaled up 2×, as on a high-density
 *  screen: its 12–13 px labels come out at 24–26 px, legible once Strava
 *  shrinks the image. */
export const GRAPH_SCALE = 2;
export const GRAPH_WIDTH = 1600;
const TITLE_BAND = 120;
const WORKOUT_HEIGHT = 760;
const PROFILE_HEIGHT = 320;
const GAP = 20;

export type GraphPanel = 'title' | 'workout' | 'elevation';

export interface GraphImageLayout {
  width: number;
  height: number;
  panels: { kind: GraphPanel; rect: Rect }[];
}

/** 1600 × 900, or 1600 × 1240 with the route's profile under the graph. */
export function graphImageLayout(hasProfile: boolean): GraphImageLayout {
  const panels: GraphImageLayout['panels'] = [
    { kind: 'title', rect: { x: 0, y: 0, w: GRAPH_WIDTH, h: TITLE_BAND } },
    { kind: 'workout', rect: { x: 0, y: TITLE_BAND, w: GRAPH_WIDTH, h: WORKOUT_HEIGHT } },
  ];
  let bottom = TITLE_BAND + WORKOUT_HEIGHT;
  if (hasProfile) {
    panels.push({ kind: 'elevation', rect: { x: 0, y: bottom + GAP, w: GRAPH_WIDTH, h: PROFILE_HEIGHT } });
    bottom += GAP + PROFILE_HEIGHT;
  }
  return { width: GRAPH_WIDTH, height: bottom + GAP, panels };
}

/** The graph image's inputs: the finished ride's graph (no hover, no live marks) and, on a route, its profile. */
export interface GraphImageInput {
  header: ImageHeader;
  graph: Omit<GraphView, 'domain' | 'live' | 'hover' | 'background'>;
  profile?: Omit<ElevationView, 'rider' | 'hoverDistance' | 'background'>;
}

/** A detached canvas of `width` × `height` pixels and its context, or undefined without canvas support. */
function canvasOf(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  return ctx ? { canvas, ctx } : undefined;
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

/** The graph canvas, painted; exported so the suite can check its size. */
export function paintGraphImage(input: GraphImageInput): HTMLCanvasElement | undefined {
  const layout = graphImageLayout(input.profile !== undefined);
  const target = canvasOf(layout.width, layout.height);
  if (!target) return undefined;
  const { canvas, ctx } = target;
  ctx.fillStyle = COLOURS.bg;
  ctx.fillRect(0, 0, layout.width, layout.height);

  for (const { kind, rect } of layout.panels) {
    ctx.save();
    ctx.setTransform(GRAPH_SCALE, 0, 0, GRAPH_SCALE, rect.x, rect.y);
    const size = { width: rect.w / GRAPH_SCALE, height: rect.h / GRAPH_SCALE };
    if (kind === 'title') {
      paintItems(ctx, headerItems(input.header, 28, 10, size.width - 56, 0.5));
    } else if (kind === 'workout') {
      const g = input.graph;
      const duration = Math.max(g.elapsed, g.samples.at(-1)?.t ?? 0);
      drawWorkoutGraph(ctx, size, { ...g, domain: wholeRideDomain(g.workout, duration), background: COLOURS.panel });
    } else if (input.profile) {
      drawElevationProfile(ctx, size, { ...input.profile, background: COLOURS.panel });
    }
    ctx.restore();
  }
  return canvas;
}

export function renderGraphImage(input: GraphImageInput): Promise<Blob | null> {
  const canvas = paintGraphImage(input);
  return canvas ? toPng(canvas) : Promise.resolve(null);
}

// ---------------------------------------------------------------------------
// Stats image

export const STATS_WIDTH = 1200;
const PAD = 56;
const COLUMNS = 4;
const CELL_GAP = 16;
const CELL_HEIGHT = 124;
const ZONE_ROW = 34;

export type CardItem =
  | { kind: 'text'; text: string; x: number; y: number; font: string; color: string; align?: CanvasTextAlign }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; color: string; radius?: number };

export interface StatsCardLayout { width: number; height: number; items: CardItem[]; }

export interface StatsCardInput {
  header: ImageHeader;
  values: readonly SummaryValue[];
  zones: readonly ZoneTime[];
  hrZones: readonly ZoneTime[];
  /** shown in place of the heart-rate bars when the ride has no heart rate */
  hrEmpty?: string;
}

export const CARD_CREDIT = 'Ridden on Cycle Indoors';

/** Title, then date · duration · FTP, with the route at the right when there was one.
 *  All text is drawn top-aligned; `scale` 0.5 is for the graph's half-size band. */
function headerItems(header: ImageHeader, x: number, y: number, width: number, scale = 1): CardItem[] {
  const items: CardItem[] = [
    { kind: 'text', text: header.title, x, y, font: `600 ${Math.round(40 * scale)}px ${SANS}`, color: COLOURS.text },
    { kind: 'text', text: header.subtitle, x, y: y + 54 * scale, font: `${Math.round(24 * scale)}px ${SANS}`, color: COLOURS.dim },
  ];
  if (header.route) {
    items.push({
      kind: 'text', text: header.route, x: x + width, y: y + 54 * scale,
      font: `${Math.round(24 * scale)}px ${SANS}`, color: COLOURS.dim, align: 'right',
    });
  }
  return items;
}

/** Time in each zone as rows of label, bar and time, starting at (x, y), `width` wide. */
function zoneItems(title: string, zones: readonly ZoneTime[], x: number, y: number, width: number, empty?: string): {
  items: CardItem[];
  bottom: number;
} {
  const items: CardItem[] = [
    { kind: 'text', text: title, x, y, font: `600 20px ${SANS}`, color: COLOURS.faint },
  ];
  let row = y + 38;
  if (empty) {
    items.push({ kind: 'text', text: empty, x, y: row, font: `20px ${SANS}`, color: COLOURS.faint });
    return { items, bottom: row + ZONE_ROW };
  }
  const longest = Math.max(1, ...zones.map((z) => z.seconds));
  const barX = x + 200;
  const barW = width - 200 - 96;
  for (const z of zones) {
    items.push(
      { kind: 'text', text: `Z${z.zone} ${z.label}`, x, y: row + 4, font: `20px ${SANS}`, color: COLOURS.dim },
      { kind: 'rect', x: barX, y: row + 6, w: barW, h: 20, color: COLOURS.track, radius: 4 },
      { kind: 'rect', x: barX, y: row + 6, w: Math.max(2, (z.seconds / longest) * barW), h: 20, color: z.color, radius: 4 },
      { kind: 'text', text: hhmmss(z.seconds), x: x + width, y: row + 4, font: `20px ${MONO}`, color: COLOURS.dim, align: 'right' },
    );
    row += ZONE_ROW;
  }
  return { items, bottom: row };
}

/**
 * The stats card: the header, every summary value in a 4-column grid with its
 * unit or note, then the power and heart-rate zone charts side by side. 1200
 * wide; as tall as its content. No text is under 18 px.
 */
export function statsCardLayout(input: StatsCardInput): StatsCardLayout {
  const inner = STATS_WIDTH - PAD * 2;
  const items: CardItem[] = [...headerItems(input.header, PAD, PAD, inner)];

  const gridTop = PAD + 110;
  const cellW = (inner - CELL_GAP * (COLUMNS - 1)) / COLUMNS;
  input.values.forEach((v, i) => {
    const x = PAD + (i % COLUMNS) * (cellW + CELL_GAP);
    const y = gridTop + Math.floor(i / COLUMNS) * (CELL_HEIGHT + CELL_GAP);
    items.push(
      { kind: 'rect', x, y, w: cellW, h: CELL_HEIGHT, color: COLOURS.raised, radius: 10 },
      { kind: 'text', text: v.label, x: x + 20, y: y + 16, font: `600 18px ${SANS}`, color: COLOURS.faint },
      { kind: 'text', text: v.value, x: x + 20, y: y + 44, font: `600 40px ${MONO}`, color: COLOURS.text },
    );
    const sub = subText(v);
    if (sub) items.push({ kind: 'text', text: sub, x: x + 20, y: y + 92, font: `18px ${SANS}`, color: COLOURS.faint });
  });
  const rows = Math.ceil(input.values.length / COLUMNS);
  const gridBottom = gridTop + rows * CELL_HEIGHT + Math.max(0, rows - 1) * CELL_GAP;

  const zonesTop = gridBottom + 44;
  const colW = (inner - 48) / 2;
  const power = zoneItems('Power zones', input.zones, PAD, zonesTop, colW);
  const hr = zoneItems('Heart-rate zones', input.hrZones, PAD + colW + 48, zonesTop, colW, input.hrEmpty);
  items.push(...power.items, ...hr.items);

  const creditY = Math.max(power.bottom, hr.bottom) + 36;
  items.push({ kind: 'text', text: CARD_CREDIT, x: PAD + inner, y: creditY, font: `18px ${SANS}`, color: COLOURS.faint, align: 'right' });
  return { width: STATS_WIDTH, height: creditY + 18 + PAD, items };
}

function paintItems(ctx: CanvasRenderingContext2D, items: readonly CardItem[]): void {
  ctx.textBaseline = 'top';
  for (const item of items) {
    if (item.kind === 'rect') {
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.roundRect(item.x, item.y, item.w, item.h, item.radius ?? 0);
      ctx.fill();
    } else {
      ctx.font = item.font;
      ctx.fillStyle = item.color;
      ctx.textAlign = item.align ?? 'left';
      ctx.fillText(item.text, item.x, item.y);
    }
  }
}

/** The stats canvas, painted; exported so the suite can check its size. */
export function paintStatsImage(input: StatsCardInput): HTMLCanvasElement | undefined {
  const layout = statsCardLayout(input);
  const target = canvasOf(layout.width, layout.height);
  if (!target) return undefined;
  const { canvas, ctx } = target;
  ctx.fillStyle = COLOURS.panel;
  ctx.fillRect(0, 0, layout.width, layout.height);
  paintItems(ctx, layout.items);
  return canvas;
}

export function renderStatsImage(input: StatsCardInput): Promise<Blob | null> {
  const canvas = paintStatsImage(input);
  return canvas ? toPng(canvas) : Promise.resolve(null);
}
