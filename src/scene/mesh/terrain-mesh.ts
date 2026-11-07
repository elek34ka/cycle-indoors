import { TILE_SIZE } from '../chunks';
import { CELL, quantise } from '../ground';
import { forEachRoadNear } from '../passes';
import { DEFAULT_PALETTE, landColour, type Palette, type RGB } from '../palette';
import type { SceneModel } from '../render/types';
import type { Ground } from '../ground';
import type { Pond } from '../ponds';

/**
 * Vertex data for one 1 km ground tile, as the GPU gets it: no three.js here,
 * so the suite can check the exact arrays drawn.
 *
 * Every tile samples the same world-aligned lattice with the same functions,
 * and every coordinate is rounded to 1/256 m and then made relative to one
 * integer origin shared by every piece of the scene. The vertices two tiles
 * share are therefore the same float32 values in both, bit for bit, and so
 * are their normals and colours: the ground is watertight across tiles, and
 * stays so when the origin moves (`shiftPositions`).
 */

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  colours: Float32Array;
  index: Uint32Array;
}

export interface Origin { x: number; z: number }

/** lattice points along a tile's side */
export const TILE_POINTS = Math.round(TILE_SIZE / CELL) + 1;

export { quantise };

/** land colour holds out to this from a road, then gives way to the far tint by LAND_FAR */
const LAND_NEAR = 20;
const LAND_FAR = 150;
/** farmland's colour bands are this wide, metres, at an angle seeded by the route */
const BAND_WIDTH = 30;

/** Integer hash to [0, 1), for speckle that is the same at a lattice point every time. */
export function speckle(seed: number, ix: number, iz: number): number {
  let h = seed ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/** 1 on every other farmland band through (x, z), else 0: a pure function of the point, so tile edges agree. */
export function farmlandBand(seed: number, x: number, z: number): number {
  const angle = (((seed >>> 0) % 360) * Math.PI) / 180;
  return Math.floor((x * Math.cos(angle) + z * Math.sin(angle)) / BAND_WIDTH) & 1;
}

/**
 * The ground's colour at lattice point (ix, iz), height h (true metres): the
 * nearest slice's land (its blended kind weights) out to LAND_NEAR from the
 * road, giving way to the far tint by LAND_FAR, with speckle.
 */
function groundColour(model: SceneModel, pal: Palette, ix: number, iz: number, h: number): RGB {
  const { p, ground, land, seed } = model;
  const rise = Math.max(0, Math.min(1, (h - ground.base) / 400));
  const far = pal.far(rise);
  let nearest = Infinity;
  let slice = -1;
  forEachRoadNear(p, ix * CELL, iz * CELL, LAND_FAR, (hit) => {
    if (hit.d < nearest) { nearest = hit.d; slice = hit.k; }
  });
  const w = slice >= 0 ? 1 - smoothstep((nearest - LAND_NEAR) / (LAND_FAR - LAND_NEAR)) : 0;
  const near = slice >= 0 ? landColour(pal, land.weights(slice), farmlandBand(seed, ix * CELL, iz * CELL)) : far;
  const s = 0.9 + 0.18 * speckle(seed, ix, iz);
  return [0, 1, 2].map((c) => (near[c] * w + far[c] * (1 - w)) * s) as RGB;
}

/**
 * Tile (tx, tz): TILE_POINTS × TILE_POINTS vertices from lattice point
 * (tx·100, tz·100), heights drawn as (h − base) × exaggeration, two
 * triangles a cell split on the v10–v01 diagonal like `drawnHeightAt`.
 */
export function buildTerrainTile(model: SceneModel, tx: number, tz: number, origin: Origin, exaggeration: number, pal: Palette = DEFAULT_PALETTE): MeshData {
  const { ground } = model;
  const n = TILE_POINTS;
  const per = n - 1;
  const ix0 = tx * per;
  const iz0 = tz * per;
  // heights with a one-point border, so normals on an edge see past it as the neighbour does
  const m = n + 2;
  const heights = new Float64Array(m * m);
  for (let b = 0; b < m; b++) {
    for (let a = 0; a < m; a++) heights[b * m + a] = ground.latticeHeight(ix0 + a - 1, iz0 + b - 1);
  }
  const H = (a: number, b: number) => heights[(b + 1) * m + (a + 1)];

  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const colours = new Float32Array(n * n * 3);
  for (let b = 0; b < n; b++) {
    for (let a = 0; a < n; a++) {
      const v = (b * n + a) * 3;
      const h = H(a, b);
      positions[v] = quantise((ix0 + a) * CELL) - origin.x;
      positions[v + 1] = (h - ground.base) * exaggeration;
      positions[v + 2] = quantise((iz0 + b) * CELL) - origin.z;
      // central differences in drawn units
      const sx = ((H(a + 1, b) - H(a - 1, b)) * exaggeration) / (2 * CELL);
      const sz = ((H(a, b + 1) - H(a, b - 1)) * exaggeration) / (2 * CELL);
      const len = Math.hypot(sx, 1, sz);
      normals[v] = -sx / len;
      normals[v + 1] = 1 / len;
      normals[v + 2] = -sz / len;
      const c = groundColour(model, pal, ix0 + a, iz0 + b, h);
      colours[v] = c[0];
      colours[v + 1] = c[1];
      colours[v + 2] = c[2];
    }
  }
  const index = new Uint32Array(per * per * 6);
  let k = 0;
  for (let b = 0; b < per; b++) {
    for (let a = 0; a < per; a++) {
      const v00 = b * n + a;
      const v10 = v00 + 1;
      const v01 = v00 + n;
      const v11 = v01 + 1;
      index[k++] = v00; index[k++] = v01; index[k++] = v10;
      index[k++] = v11; index[k++] = v10; index[k++] = v01;
    }
  }
  return { positions, normals, colours, index };
}

/**
 * Moves a piece's vertices to a new origin `dx`, `dz` metres from the old
 * one (integers). Exact on rounded coordinates, so a shifted piece equals one
 * built at the new origin, bit for bit.
 */
export function shiftPositions(positions: Float32Array, dx: number, dz: number): void {
  for (let v = 0; v < positions.length; v += 3) {
    positions[v] -= dx;
    positions[v + 2] -= dz;
  }
}

/** sides of a pond's water polygon */
export const WATER_SIDES = 32;

/** The ponds whose centre lies in tile (tx, tz), half-open, so each pond belongs to exactly one tile. */
export function tilePonds(ground: Ground, tx: number, tz: number): Pond[] {
  const x0 = tx * TILE_SIZE;
  const z0 = tz * TILE_SIZE;
  const x1 = x0 + TILE_SIZE;
  const z1 = z0 + TILE_SIZE;
  return ground.ponds(x0, z0, x1, z1).filter((q) => q.cx >= x0 && q.cx < x1 && q.cz >= z0 && q.cz < z1);
}

/**
 * The water of tile (tx, tz)'s ponds: per pond, a flat WATER_SIDES-gon at
 * (level − base) × exaggeration, a fan from its centre facing up. It
 * circumscribes the disc of radius R (vertices at R / cos(π/WATER_SIDES)),
 * so every point of its edge is at least R from the centre, where the shore
 * is above the water.
 */
export function buildPondWater(model: SceneModel, tx: number, tz: number, origin: Origin, exaggeration: number, pal: Palette = DEFAULT_PALETTE): MeshData {
  const ponds = tilePonds(model.ground, tx, tz);
  const per = WATER_SIDES + 1;
  const positions = new Float32Array(ponds.length * per * 3);
  const normals = new Float32Array(ponds.length * per * 3);
  const colours = new Float32Array(ponds.length * per * 3);
  const index = new Uint32Array(ponds.length * WATER_SIDES * 3);
  const out = Math.cos(Math.PI / WATER_SIDES);
  ponds.forEach((pond, n) => {
    const y = (pond.level - model.ground.base) * exaggeration;
    const v0 = n * per;
    for (let k = 0; k < per; k++) {
      const a = ((k - 1) / WATER_SIDES) * 2 * Math.PI;
      const rad = k === 0 ? 0 : pond.R / out;
      const v = (v0 + k) * 3;
      positions[v] = pond.cx + rad * Math.cos(a) - origin.x;
      positions[v + 1] = y;
      positions[v + 2] = pond.cz + rad * Math.sin(a) - origin.z;
      normals[v + 1] = 1;
      colours.set(pal.water, v);
    }
    for (let k = 0; k < WATER_SIDES; k++) {
      const t = (n * WATER_SIDES + k) * 3;
      // centre, next, this: counter-clockwise seen from above, so the face looks up
      index[t] = v0;
      index[t + 1] = v0 + 1 + ((k + 1) % WATER_SIDES);
      index[t + 2] = v0 + 1 + k;
    }
  });
  return { positions, normals, colours, index };
}
