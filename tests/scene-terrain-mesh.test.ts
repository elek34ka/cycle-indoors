import { setupDom } from './dom-setup';
setupDom();

const { Course } = await import('../src/activity/course');
const { buildGeometry, routeSeed } = await import('../src/scene/geometry');
const { parseGpx } = await import('../src/activity/gpx');
const { readFileSync } = await import('node:fs');
const { buildViewProfile } = await import('../src/scene/view-profile');
const { buildPasses } = await import('../src/scene/passes');
const { buildGround, CELL } = await import('../src/scene/ground');
const { buildLand } = await import('../src/scene/landscape');
const { ChunkPlanner, TILE_SIZE } = await import('../src/scene/chunks');
const { buildTerrainTile, buildPondWater, tilePonds, shiftPositions, TILE_POINTS, WATER_SIDES } = await import('../src/scene/mesh/terrain-mesh');
const { check, near, report, suite } = await import('./harness');
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
const t0 = performance.now();
const tile = buildTerrainTile(model, tx, tz, origin, EX);
const buildMs = performance.now() - t0;
const east = buildTerrainTile(model, tx + 1, tz, origin, EX);
const south = buildTerrainTile(model, tx, tz + 1, origin, EX);

const bits = (a: Float32Array, i: number, b: Float32Array, j: number) =>
  a[i] === b[j] && a[i + 1] === b[j + 1] && a[i + 2] === b[j + 2] && Object.is(a[i], b[j]);

suite('terrain mesh: one tile', () => {
  check(`${n} × ${n} vertices, two triangles a cell`, tile.positions.length === n * n * 3 && tile.index.length === (n - 1) * (n - 1) * 6);
  // every edge between two triangles is shared by exactly two; the border's by one
  const edges = new Map<string, number>();
  for (let t = 0; t < tile.index.length; t += 3) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const u = tile.index[t + a];
      const v = tile.index[t + b];
      const key = u < v ? `${u},${v}` : `${v},${u}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  let inner = 0;
  let badInner = 0;
  let badBorder = 0;
  const edgeLine = (c: number) => c === 0 || c === n - 1;
  for (const [key, count] of edges) {
    const [u, v] = key.split(',').map(Number);
    // both ends on the same border column or row
    const border = (u % n === v % n && edgeLine(u % n)) || (Math.floor(u / n) === Math.floor(v / n) && edgeLine(Math.floor(u / n)));
    if (border) { if (count !== 1) badBorder++; } else { inner++; if (count !== 2) badInner++; }
  }
  check(`every inner edge is shared by exactly two triangles (${inner})`, badInner === 0, `${badInner}`);
  check('only the tile\'s border edges belong to a single triangle', badBorder === 0, `${badBorder}`);
  let degenerate = 0;
  for (let t = 0; t < tile.index.length; t += 3) {
    const [a, b, c] = [tile.index[t], tile.index[t + 1], tile.index[t + 2]];
    if (a === b || b === c || a === c) degenerate++;
  }
  check('no degenerate triangles', degenerate === 0);
  let badNormal = 0;
  for (let v = 0; v < tile.normals.length; v += 3) {
    const len = Math.hypot(tile.normals[v], tile.normals[v + 1], tile.normals[v + 2]);
    if (Math.abs(len - 1) > 1e-5 || tile.normals[v + 1] <= 0) badNormal++;
  }
  check('normals are unit length and point up', badNormal === 0, `${badNormal}`);
  check(`a 1 km tile builds in under 300 ms (${buildMs.toFixed(0)} ms)`, buildMs < 300);
});

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

suite('terrain mesh: moving the origin', () => {
  const moved = { x: origin.x + 2137, z: origin.z - 1999 };
  const shifted = Float32Array.from(tile.positions);
  shiftPositions(shifted, moved.x - origin.x, moved.z - origin.z);
  const fresh = buildTerrainTile(model, tx, tz, moved, EX);
  let differ = 0;
  for (let v = 0; v < shifted.length; v++) if (!Object.is(shifted[v], fresh.positions[v])) differ++;
  check('a shifted tile equals one built at the new origin, bit for bit', differ === 0, `${differ} floats differ`);
});

suite('terrain mesh: drawn height is the mesh', () => {
  // random points in the tile: find their triangle in the arrays, interpolate, compare
  let worst = 0;
  let rand = 12345;
  const next = () => ((rand = (Math.imul(rand, 1103515245) + 12345) >>> 0) / 4294967296);
  for (let s = 0; s < 500; s++) {
    const fa = next() * (n - 1);
    const fb = next() * (n - 1);
    const a = Math.floor(fa);
    const b = Math.floor(fb);
    const u = fa - a;
    const w = fb - b;
    const Y = (aa: number, bb: number) => tile.positions[(bb * n + aa) * 3 + 1];
    const y = u + w <= 1
      ? Y(a, b) + (Y(a + 1, b) - Y(a, b)) * u + (Y(a, b + 1) - Y(a, b)) * w
      : Y(a + 1, b + 1) + (Y(a, b + 1) - Y(a + 1, b + 1)) * (1 - u) + (Y(a + 1, b) - Y(a + 1, b + 1)) * (1 - w);
    const x = (tx * (n - 1) + a + u) * CELL;
    const z = (tz * (n - 1) + b + w) * CELL;
    worst = Math.max(worst, Math.abs(y / EX + ground.base - ground.drawnHeightAt(x, z)));
  }
  near('drawnHeightAt agrees with the tile\'s own triangles at 500 random points (to float32)', worst, 0, 1e-3);
});

suite('terrain mesh: pond water', () => {
  // the sample loop again, its ground built with the route's land, so it holds ponds
  const land = buildLand(g, p, seed);
  const wet = buildGround(p, seed, g, land);
  const wetModel: SceneModel = { ...model, ground: wet, land };
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < p.count; i++) { x0 = Math.min(x0, p.px[i]); x1 = Math.max(x1, p.px[i]); z0 = Math.min(z0, p.pz[i]); z1 = Math.max(z1, p.pz[i]); }
  const all = wet.ponds(x0 - 500, z0 - 500, x1 + 500, z1 + 500);
  check(`the sample loop has ponds (${all.length})`, all.length > 0);
  // every pond in exactly one tile, the one its centre is in
  const seen = new Map<string, number>();
  for (let a = Math.floor((x0 - 500) / TILE_SIZE); a <= Math.floor((x1 + 500) / TILE_SIZE); a++) {
    for (let b = Math.floor((z0 - 500) / TILE_SIZE); b <= Math.floor((z1 + 500) / TILE_SIZE); b++) {
      for (const q of tilePonds(wet, a, b)) seen.set(`${q.cx},${q.cz}`, (seen.get(`${q.cx},${q.cz}`) ?? 0) + 1);
    }
  }
  check('every pond belongs to exactly one tile', seen.size === all.length && [...seen.values()].every((c) => c === 1));
  let sides = 0, flat = 0, up = 0, rimWet = 0, edgeWet = 0, short = 0, rims = 0;
  for (const q of all) {
    const ta = Math.floor(q.cx / TILE_SIZE);
    const tb = Math.floor(q.cz / TILE_SIZE);
    const w = buildPondWater(wetModel, ta, tb, origin, EX);
    const mine = tilePonds(wet, ta, tb).indexOf(q);
    const per = WATER_SIDES + 1;
    if (w.index.length !== tilePonds(wet, ta, tb).length * WATER_SIDES * 3) sides++;
    const v = (k: number) => [w.positions[(mine * per + k) * 3] + origin.x, w.positions[(mine * per + k) * 3 + 1], w.positions[(mine * per + k) * 3 + 2] + origin.z];
    const y = (q.level - wet.base) * EX;
    for (let k = 0; k < per; k++) if (Math.abs(v(k)[1] - y) > 1e-3) flat++;
    for (let t = mine * WATER_SIDES * 3; t < (mine + 1) * WATER_SIDES * 3; t += 3) {
      const [a, b, c] = [w.index[t], w.index[t + 1], w.index[t + 2]].map((i) => [w.positions[i * 3], w.positions[i * 3 + 2]]);
      // y of (b − a) × (c − a): positive faces up
      if ((b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]) <= 0) up++;
    }
    for (let k = 1; k < per; k++) {
      const [x, , z] = v(k);
      rims++;
      if (wet.drawnHeightAt(x, z) <= q.level) rimWet++;
      const [nx, , nz] = v(k === WATER_SIDES ? 1 : k + 1);
      for (let s = 0; s <= 10; s++) {
        const ex = x + ((nx - x) * s) / 10;
        const ez = z + ((nz - z) * s) / 10;
        if (wet.drawnHeightAt(ex, ez) <= q.level) edgeWet++;
        if (Math.hypot(ex - q.cx, ez - q.cz) < q.R - 1e-3) short++;
      }
    }
  }
  check(`each pond is a ${WATER_SIDES}-sided fan`, sides === 0);
  check('the water is flat at the level, exaggerated like the ground', flat === 0, `${flat}`);
  check('every water triangle faces up', up === 0, `${up}`);
  check(`every rim vertex is buried: the drawn ground above the water (${rims} vertices)`, rimWet === 0, `${rimWet}`);
  check('and every point of every edge, sampled at tenths', edgeWet === 0, `${edgeWet}`);
  check('the polygon covers the whole disc of radius R', short === 0, `${short}`);
  const dry = buildPondWater(model, tx, tz, origin, EX);
  check('a ground without ponds draws no water', dry.index.length === 0 && dry.positions.length === 0);
});

report();
