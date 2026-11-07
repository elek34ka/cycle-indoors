import type { LandKind } from './landscape';
import { LAND_KINDS } from './landscape';
import type { SceneryKind } from './scenery';

/**
 * Every colour the 3D view draws, by season. Pure data: nothing that places
 * or shapes the scene reads it, so a season can change colours but never
 * move anything. Colours are linear-ish RGB in [0, 1].
 */

export type RGB = [number, number, number];
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];

export const SCENERY_PARTS = ['trunk', 'paleTrunk', 'branches', 'pine', 'spruce', 'leaves', 'oak', 'birch', 'poplar', 'bush', 'rock', 'post'] as const;
export type SceneryPart = (typeof SCENERY_PARTS)[number];

/** the ground details' colours: grass blades (and flower stems), reeds and their heads, stones, and three flower colours */
export const DETAIL_PARTS = ['grass', 'reed', 'reedHead', 'stone', 'flowerWhite', 'flowerYellow', 'flowerViolet'] as const;
export type DetailPart = (typeof DETAIL_PARTS)[number];
/** a flower's colour, by its tint: about two in five white, then yellow, then violet */
export const flowerPart = (tint: number): DetailPart => (tint < 0.4 ? 'flowerWhite' : tint < 0.75 ? 'flowerYellow' : 'flowerViolet');

export interface Palette {
  season: Season;
  /** the land beside the road, by kind */
  ground: Record<LandKind, RGB>;
  /** farmland's second colour, for its bands */
  farmlandBand: RGB;
  /** the land far from any road, by rise above the route's lowest point (0 low … 1 high) */
  far(rise: number): RGB;
  scenery: Record<SceneryPart, RGB>;
  details: Record<DetailPart, RGB>;
  /** still water in ponds; ice in winter */
  water: RGB;
  /** the road itself, the same in every season: asphalt, the gravel shoulder and the verge's first band, and paint */
  road: { asphalt: RGB; gravel: RGB; paint: RGB };
}

/** the road never changes with the season: winter keeps it clear */
const ROAD = { asphalt: [0.33, 0.34, 0.37] as RGB, gravel: [0.52, 0.48, 0.4] as RGB, paint: [0.95, 0.95, 0.92] as RGB };

/** the trees that lose their leaves: drawn as bare branches in winter */
const DECIDUOUS: readonly SceneryKind[] = ['broadleaf', 'oak', 'birch', 'poplar'];

/** Whether a tree of this kind is drawn bare, branches without a crown, in this season. */
export function bare(kind: SceneryKind, season: Season): boolean {
  return season === 'winter' && DECIDUOUS.includes(kind);
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
  details: {
    grass: [0.36, 0.6, 0.22],
    reed: [0.42, 0.55, 0.26],
    reedHead: [0.36, 0.24, 0.14],
    stone: [0.6, 0.58, 0.53],
    flowerWhite: [0.95, 0.94, 0.88],
    flowerYellow: [0.96, 0.82, 0.22],
    flowerViolet: [0.6, 0.42, 0.78],
  },
  water: [0.22, 0.4, 0.48],
  road: ROAD,
};

/** fresher greens, young leaves, ploughed soil between the bands, bright flowers */
const SPRING: Palette = {
  season: 'spring',
  ground: {
    fields: [0.48, 0.72, 0.3],
    meadow: [0.45, 0.76, 0.32],
    farmland: [0.55, 0.6, 0.32],
    mixed: [0.36, 0.62, 0.27],
    broadleaf: [0.33, 0.58, 0.25],
    conifer: [0.22, 0.42, 0.21],
    heath: [0.5, 0.5, 0.36],
    upland: [0.5, 0.54, 0.34],
  },
  farmlandBand: [0.5, 0.4, 0.27],
  far: (rise) => [0.38 + 0.14 * rise, 0.62 - 0.1 * rise, 0.28 + 0.06 * rise],
  scenery: {
    ...SUMMER.scenery,
    pine: [0.14, 0.34, 0.18],
    spruce: [0.1, 0.28, 0.21],
    leaves: [0.42, 0.68, 0.26],
    oak: [0.38, 0.6, 0.22],
    birch: [0.58, 0.76, 0.3],
    poplar: [0.45, 0.68, 0.26],
    bush: [0.4, 0.62, 0.24],
  },
  details: {
    ...SUMMER.details,
    grass: [0.42, 0.7, 0.26],
    reed: [0.45, 0.62, 0.28],
    reedHead: [0.4, 0.3, 0.18],
    flowerWhite: [0.97, 0.96, 0.92],
    flowerYellow: [0.98, 0.86, 0.2],
    flowerViolet: [0.62, 0.45, 0.85],
  },
  water: [0.24, 0.44, 0.5],
  road: ROAD,
};

/** crowns in yellow, orange and red, browning grass, stubble and ploughed bands, heather */
const AUTUMN: Palette = {
  season: 'autumn',
  ground: {
    fields: [0.55, 0.6, 0.3],
    meadow: [0.5, 0.6, 0.3],
    farmland: [0.62, 0.55, 0.32],
    mixed: [0.42, 0.5, 0.24],
    broadleaf: [0.45, 0.42, 0.22],
    conifer: [0.24, 0.36, 0.2],
    heath: [0.52, 0.38, 0.32],
    upland: [0.5, 0.47, 0.33],
  },
  farmlandBand: [0.48, 0.36, 0.24],
  far: (rise) => [0.44 + 0.12 * rise, 0.5 - 0.08 * rise, 0.26 + 0.06 * rise],
  scenery: {
    ...SUMMER.scenery,
    leaves: [0.85, 0.5, 0.12],
    oak: [0.7, 0.22, 0.1],
    birch: [0.92, 0.78, 0.2],
    poplar: [0.88, 0.7, 0.18],
    bush: [0.62, 0.34, 0.14],
  },
  details: {
    ...SUMMER.details,
    grass: [0.55, 0.55, 0.28],
    reed: [0.6, 0.52, 0.3],
    reedHead: [0.35, 0.22, 0.12],
    flowerWhite: [0.85, 0.82, 0.75],
    flowerYellow: [0.82, 0.66, 0.2],
    flowerViolet: [0.5, 0.36, 0.6],
  },
  water: [0.2, 0.34, 0.4],
  road: ROAD,
};

/**
 * Snow on the ground and verges, a little shadowed under trees; the road and
 * the verge's gravel band stay clear (`road`). Deciduous trees are bare
 * (`bare`), so their crown colours are never drawn; grass and flowers are
 * straw and seed heads poking through, and the ponds are ice.
 */
const WINTER: Palette = {
  season: 'winter',
  ground: {
    fields: [0.92, 0.94, 0.96],
    meadow: [0.93, 0.95, 0.97],
    farmland: [0.9, 0.92, 0.94],
    mixed: [0.86, 0.89, 0.92],
    broadleaf: [0.84, 0.87, 0.9],
    conifer: [0.8, 0.84, 0.88],
    heath: [0.88, 0.9, 0.92],
    upland: [0.95, 0.96, 0.98],
  },
  farmlandBand: [0.86, 0.88, 0.9],
  far: (rise) => [0.88 + 0.08 * rise, 0.9 + 0.07 * rise, 0.93 + 0.05 * rise],
  scenery: {
    ...SUMMER.scenery,
    trunk: [0.3, 0.22, 0.16],
    branches: [0.38, 0.33, 0.28],
    pine: [0.1, 0.26, 0.17],
    spruce: [0.08, 0.22, 0.19],
    leaves: [0.4, 0.34, 0.28],
    oak: [0.4, 0.34, 0.28],
    birch: [0.4, 0.34, 0.28],
    poplar: [0.4, 0.34, 0.28],
    bush: [0.42, 0.36, 0.3],
    rock: [0.58, 0.57, 0.55],
  },
  details: {
    grass: [0.72, 0.66, 0.5],
    reed: [0.66, 0.58, 0.4],
    reedHead: [0.3, 0.2, 0.12],
    stone: [0.62, 0.61, 0.58],
    flowerWhite: [0.9, 0.9, 0.9],
    flowerYellow: [0.7, 0.6, 0.42],
    flowerViolet: [0.55, 0.48, 0.42],
  },
  water: [0.78, 0.86, 0.92],
  road: ROAD,
};

const PALETTES: Record<Season, Palette> = { spring: SPRING, summer: SUMMER, autumn: AUTUMN, winter: WINTER };

export function palette(season: Season): Palette {
  return PALETTES[season];
}

/** the season the window opens in */
export const DEFAULT_SEASON: Season = 'summer';
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
