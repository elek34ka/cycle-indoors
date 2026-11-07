import { ChunkPlanner } from '../src/scene/chunks';
import { buildRoadChunk } from '../src/scene/mesh/road-mesh';
import type { RouteGeometry } from '../src/scene/geometry';
import type { Ground } from '../src/scene/ground';
import type { Land } from '../src/scene/landscape';
import type { Passes } from '../src/scene/passes';

export interface FootingScene { g: RouteGeometry; p: Passes; ground: Ground; land: Land; seed: number }

/**
 * The topmost drawn surface at (x, z), read from what is drawn: the ground
 * lattice's triangles (drawnHeightAt, which the terrain-mesh suite matches
 * to the tile arrays) and every road and verge triangle in the road chunks'
 * arrays. Independent of `surfaceAt`, which is what it checks.
 */
export function drawnTop(s: FootingScene): (x: number, z: number) => number {
  const { g, p, ground, land, seed } = s;
  const planner = new ChunkPlanner(g, p);
  const model = { g, p, ground, land, seed, chunkRange: (c: number) => planner.chunkRange(c) };
  const grid = new Map<string, number[][]>();
  const key = (x: number, z: number) => `${Math.floor(x / 20)},${Math.floor(z / 20)}`;
  for (let c = 0; c < planner.chunkCount; c++) {
    const chunk = buildRoadChunk(model, c, { x: 0, z: 0 }, 1);
    for (const m of [...chunk.road, ...chunk.verge]) {
      for (let t = 0; t < m.index.length; t += 3) {
        const tri = [0, 1, 2].flatMap((e) => { const v = m.index[t + e] * 3; return [m.positions[v], m.positions[v + 1] + ground.base, m.positions[v + 2]]; });
        const x0 = Math.min(tri[0], tri[3], tri[6]), x1 = Math.max(tri[0], tri[3], tri[6]);
        const z0 = Math.min(tri[2], tri[5], tri[8]), z1 = Math.max(tri[2], tri[5], tri[8]);
        for (let gx = Math.floor(x0 / 20); gx <= Math.floor(x1 / 20); gx++) {
          for (let gz = Math.floor(z0 / 20); gz <= Math.floor(z1 / 20); gz++) {
            const k = `${gx},${gz}`;
            const list = grid.get(k) ?? [];
            list.push(tri);
            grid.set(k, list);
          }
        }
      }
    }
  }
  return (x, z) => {
    let top = ground.drawnHeightAt(x, z);
    for (const t of grid.get(key(x, z)) ?? []) {
      const [ax, ah, az, bx, bh, bz, cx, ch, cz] = t;
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-9) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
      top = Math.max(top, l1 * ah + l2 * bh + l3 * ch);
    }
    return top;
  };
}

/** The worst |base − drawn surface| over the items, metres. */
export function baseError(s: FootingScene, items: { x: number; z: number; y: number }[]): number {
  const top = drawnTop(s);
  let worst = 0;
  for (const it of items) worst = Math.max(worst, Math.abs(it.y - top(it.x, it.z)));
  return worst;
}

/** Distance from (x, z) to every segment of a line, by brute force
 *  (independent of the spatial hash the code under test uses). */
export function bruteDistance(g: { count: number; x: Float64Array; z: Float64Array }, x: number, z: number): number {
  let best = Infinity;
  for (let k = 0; k + 1 < g.count; k++) {
    const dx = g.x[k + 1] - g.x[k];
    const dz = g.z[k + 1] - g.z[k];
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((x - g.x[k]) * dx + (z - g.z[k]) * dz) / len2)) : 0;
    best = Math.min(best, Math.hypot(g.x[k] + dx * t - x, g.z[k] + dz * t - z));
  }
  return best;
}
