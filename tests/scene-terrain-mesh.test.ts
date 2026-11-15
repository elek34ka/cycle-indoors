import { setupDom } from './dom-setup';
setupDom();

const { Course } = await import('../src/activity/course');
const { buildGeometry, routeSeed } = await import('../src/scene/geometry');
const { parseGpx } = await import('../src/activity/gpx');
const { readFileSync } = await import('node:fs');
const { buildViewProfile } = await import('../src/scene/view-profile');
const { buildPasses } = await import('../src/scene/passes');
const { buildGround } = await import('../src/scene/ground');
const { buildLand } = await import('../src/scene/landscape');
const { ChunkPlanner, TILE_SIZE } = await import('../src/scene/chunks');
const { buildTerrainTile, TILE_POINTS } = await import('../src/scene/mesh/terrain-mesh');
const { check, report, suite } = await import('./harness');
import type { SceneModel } from '../src/scene/render/types';

const course = new Course(parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'Sample'));
const g = buildGeometry(course);
const p = buildPasses(g, buildViewProfile(course, g));
const seed = routeSeed(g);
const ground = buildGround(p, seed, g);
const planner = new ChunkPlanner(g, p);
const model: SceneModel = { g, p, ground, land: buildLand(g, p, seed), seed, chunkRange: (c) => planner.chunkRange(c) };
const EX = 2.5;
const origin = { x: Math.round(p.px[600]), z: Math.round(p.pz[600]) };
// the tile under slice 600 and its neighbours to the east and south
const tx = Math.floor(p.px[600] / TILE_SIZE);
const tz = Math.floor(p.pz[600] / TILE_SIZE);
const n = TILE_POINTS;
const tile = buildTerrainTile(model, tx, tz, origin, EX);
const east = buildTerrainTile(model, tx + 1, tz, origin, EX);
const south = buildTerrainTile(model, tx, tz + 1, origin, EX);

const bits = (a: Float32Array, i: number, b: Float32Array, j: number) =>
  a[i] === b[j] && a[i + 1] === b[j + 1] && a[i + 2] === b[j + 2] && Object.is(a[i], b[j]);

suite('terrain mesh: neighbouring tiles share their edge bit for bit', () => {
  let pos = 0, nor = 0, col = 0;
  for (let b = 0; b < n; b++) {
    const i = (b * n + (n - 1)) * 3; // this tile's east edge
    const j = (b * n) * 3; // the east tile's west edge
    if (!bits(tile.positions, i, east.positions, j)) pos++;
    if (!bits(tile.normals, i, east.normals, j)) nor++;
    if (!bits(tile.colours, i, east.colours, j)) col++;
  }
  for (let a = 0; a < n; a++) {
    const i = ((n - 1) * n + a) * 3; // south edge
    const j = a * 3; // the south tile's north edge
    if (!bits(tile.positions, i, south.positions, j)) pos++;
    if (!bits(tile.normals, i, south.normals, j)) nor++;
    if (!bits(tile.colours, i, south.colours, j)) col++;
  }
  check('positions, east and south', pos === 0, `${pos} differ`);
  check('normals, so the lighting has no seam', nor === 0, `${nor} differ`);
  check('colours', col === 0, `${col} differ`);
});

report();
