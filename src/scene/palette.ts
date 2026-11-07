import type { LandKind } from './landscape';
import { LAND_KINDS } from './landscape';

/**
 * Every colour the 3D view draws, by season. Pure data: nothing that places
 * or shapes the scene reads it, so a season can change colours but never
 * move anything. Colours are linear-ish RGB in [0, 1].
 */

export type RGB = [number, number, number];
export const SEASONS = ['summer'] as const;
export type Season = (typeof SEASONS)[number];

export const SCENERY_PARTS = ['trunk', 'paleTrunk', 'branches', 'pine', 'spruce', 'leaves', 'oak', 'birch', 'poplar', 'bush', 'rock', 'post'] as const;
export type SceneryPart = (typeof SCENERY_PARTS)[number];

export interface Palette {
  season: Season;
  /** the land beside the road, by kind */
  ground: Record<LandKind, RGB>;
  /** farmland's second colour, for its bands */
  farmlandBand: RGB;
  /** the land far from any road, by rise above the route's lowest point (0 low … 1 high) */
  far(rise: number): RGB;
  scenery: Record<SceneryPart, RGB>;
  /** still water in ponds */
  water: RGB;
}

const SUMMER: Palette = {
  season: 'summer',
  ground: {
    fields: [0.47, 0.66, 0.29],
    meadow: [0.44, 0.7, 0.31],
    farmland: [0.6, 0.62, 0.3],
    mixed: [0.33, 0.56, 0.25],
    broadleaf: [0.28, 0.5, 0.22],
    conifer: [0.21, 0.39, 0.2],
    heath: [0.5, 0.45, 0.36],
    upland: [0.49, 0.5, 0.33],
  },
  farmlandBand: [0.7, 0.62, 0.34],
  far: (rise) => [0.36 + 0.16 * rise, 0.56 - 0.1 * rise, 0.26 + 0.06 * rise],
  scenery: {
    trunk: [0.35, 0.24, 0.16],
    paleTrunk: [0.86, 0.85, 0.8],
    branches: [0.42, 0.36, 0.3],
    pine: [0.12, 0.3, 0.17],
    spruce: [0.09, 0.25, 0.2],
    leaves: [0.25, 0.48, 0.18],
    oak: [0.22, 0.42, 0.15],
    birch: [0.45, 0.62, 0.25],
    poplar: [0.3, 0.52, 0.2],
    bush: [0.31, 0.49, 0.2],
    rock: [0.54, 0.52, 0.47],
    post: [0.93, 0.93, 0.93],
  },
  water: [0.22, 0.4, 0.48],
};

const PALETTES: Record<Season, Palette> = { summer: SUMMER };

export function palette(season: Season): Palette {
  return PALETTES[season];
}

export const DEFAULT_PALETTE = SUMMER;

/**
 * The land colour for a slice's kind weights (LAND_KINDS order). `band`, in
 * [0, 1], is how much of farmland's share shows its second colour.
 */
export function landColour(pal: Palette, weights: ArrayLike<number>, band = 0): RGB {
  const out: RGB = [0, 0, 0];
  LAND_KINDS.forEach((kind, k) => {
    const w = weights[k];
    if (!w) return;
    const c = pal.ground[kind];
    const alt = kind === 'farmland' ? pal.farmlandBand : c;
    for (let ch = 0; ch < 3; ch++) out[ch] += w * (c[ch] * (1 - band) + alt[ch] * band);
  });
  return out;
}
