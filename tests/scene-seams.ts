/**
 * Seam measures for the 3D view's drawn ground, shared by the scene suites
 * and the local debug run on the owner's route (never part of the suite).
 */
import { Course } from '../src/activity/course';
import { buildGeometry, routeSeed } from '../src/scene/geometry';
import { buildViewProfile } from '../src/scene/view-profile';
import { buildPasses, forEachRoadNear, forEachSegmentNear, ROAD_HALF_WIDTH, segmentDrawn } from '../src/scene/passes';
import { buildGround, quantise, ROAD_EDGE, VERGE_OFFSETS } from '../src/scene/ground';
import { buildLand } from '../src/scene/landscape';
import { ChunkPlanner } from '../src/scene/chunks';
import { buildRoadChunk, roadLayers } from '../src/scene/mesh/road-mesh';
import { trackFromLocal } from './scene-fixtures';
import type { LocalPoint } from './scene-fixtures';
import type { ActivityTrack } from '../src/activity/types';
import type { Passes } from '../src/scene/passes';
import type { RouteGeometry } from '../src/scene/geometry';
import type { Ground } from '../src/scene/ground';
import type { SceneModel } from '../src/scene/render/types';
import type { MeshData } from '../src/scene/mesh/terrain-mesh';
import type { RoadChunkData } from '../src/scene/mesh/road-mesh';
import type { LandKind } from '../src/scene/landscape';

/** The lowest road whose footprint (asphalt and shoulder) covers (x, z), or Infinity: each road's surface there, not a neighbouring segment's clamped end. */
function lowestRoadAt(p: Passes, x: number, z: number): number {
  let lowest = Infinity;
  forEachRoadNear(p, x, z, ROAD_EDGE, (hit) => { if (hit.h < lowest) lowest = hit.h; });
  return lowest;
}

/**
 * Walks every drawn segment's footprint every `along` metres and every 0.5 m
 * across it, comparing the drawn ground (the lattice's triangles, not just
 * its vertices) with the lowest road there.
 */
export function coverViolations(g: RouteGeometry, p: Passes, ground: Ground, along = 1) {
  let over = 0;
  let samples = 0;
  let worst = -Infinity;
  for (let i = 0; i + 1 < g.count; i++) {
    if (!segmentDrawn(p, i)) continue;
    const j = i + 1;
    const len = Math.hypot(p.px[j] - p.px[i], p.pz[j] - p.pz[i]);
    const steps = Math.max(1, Math.ceil(len / along));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const cx = p.px[i] + (p.px[j] - p.px[i]) * t;
      const cz = p.pz[i] + (p.pz[j] - p.pz[i]) * t;
      const rx = g.rx[i] + (g.rx[j] - g.rx[i]) * t;
      const rz = g.rz[i] + (g.rz[j] - g.rz[i]) * t;
      const rl = Math.hypot(rx, rz) || 1;
      for (let o = -ROAD_EDGE + 0.05; o <= ROAD_EDGE - 0.05 + 1e-9; o += 0.5) {
        const x = cx + (rx / rl) * o;
        const z = cz + (rz / rl) * o;
        const road = lowestRoadAt(p, x, z);
        if (!Number.isFinite(road)) continue;
        samples++;
        const h = ground.drawnHeightAt(x, z);
        worst = Math.max(worst, h - road);
        if (!(h < road)) over++;
      }
    }
  }
  return { over, samples, worst };
}

/** Most a drawn edge may stand above the ground beside it: 0.5 m drawn at the steepest exaggeration, 4×. */
export const FLOAT_LIMIT = 0.5 / 4;

/**
 * Where a road floats: its edge more than FLOAT_LIMIT above the drawn surface
 * just beside it.
 *
 * Where a verge is drawn, this is checked on its own vertices, which is what
 * the mesh draws: its inner ring must be exactly the road's edge (position
 * and height), and its next ring, 2.5 m out, may sit lower only where
 * another pass, more than 8 slices away, is lower within 150 m. Sampling
 * points beside the edge would misjudge which stretch a point inside a sharp
 * corner belongs to.
 *
 * Where no verge fits, the drawn surface (lattice, or a tapering verge) 0.5 m
 * and 1 m beside the edge is sampled. Allowed only where another pass meets
 * this road within 40 m (the reach of two verges) and more than 3 slices along the route (a merge, a
 * U-turn's other leg or its tip, where the heading reverses within 5 slices, the far side of a tight corner, a loop's finish riding
 * onto its start), or lies lower within 60 m. The road's skirt closes the side
 * in both.
 */
/** Whether slice i is at a U-turn: the heading reverses (by more than 120°) within 5 slices either side. */
export function uTurnAt(g: RouteGeometry, i: number): boolean {
  const a = Math.max(0, i - 5);
  const b = Math.min(g.count - 1, i + 5);
  return g.tx[a] * g.tx[b] + g.tz[a] * g.tz[b] < Math.cos((120 * Math.PI) / 180);
}

export function floatViolations(g: RouteGeometry, p: Passes, ground: Ground) {
  let floating = 0;
  let detached = 0;
  let excused = 0;
  let samples = 0;
  let worst = 0;
  let where = '';
  for (let i = 0; i + 1 < g.count; i++) {
    if (!segmentDrawn(p, i)) continue;
    const j = i + 1;
    for (const side of [-1, 1]) {
      if (ground.vergeWidth(i, side) > 0 && ground.vergeWidth(j, side) > 0) {
        for (const k of [i, j]) {
          samples++;
          const ring = ground.vergeRing(k, side);
          const ex = quantise(p.px[k] + g.rx[k] * ROAD_EDGE * side);
          const ez = quantise(p.pz[k] + g.rz[k] * ROAD_EDGE * side);
          if (ring.x[0] !== ex || ring.z[0] !== ez || ring.h[0] !== p.ph[k]) detached++;
          const drop = p.ph[k] - ring.h[1];
          if (drop <= FLOAT_LIMIT) continue;
          let lower = false;
          forEachRoadNear(p, ring.x[1], ring.z[1], 150, (hit) => { if (Math.abs(hit.k - k) > 8 && hit.h < p.ph[k]) lower = true; });
          if (lower) { excused++; continue; }
          floating++;
          if (drop > worst) { worst = drop; where = `${(g.distance[k] / 1000).toFixed(2)} km, ${side < 0 ? 'left' : 'right'} verge`; }
        }
        continue;
      }
      for (let t = 0; t < 1; t += 0.1) {
        const cx = p.px[i] + (p.px[j] - p.px[i]) * t;
        const cz = p.pz[i] + (p.pz[j] - p.pz[i]) * t;
        const rx = g.rx[i] + (g.rx[j] - g.rx[i]) * t;
        const rz = g.rz[i] + (g.rz[j] - g.rz[i]) * t;
        const rl = Math.hypot(rx, rz) || 1;
        const edge = p.ph[i] + (p.ph[j] - p.ph[i]) * t;
        for (const out of [0.5, 1]) {
          const o = side * (ROAD_EDGE + out);
          const x = cx + (rx / rl) * o;
          const z = cz + (rz / rl) * o;
          // standing on any drawn road, as on the inside of a sharp corner, is not beside this one
          let onRoad = false;
          forEachSegmentNear(p, x, z, ROAD_EDGE, (hit) => { if (segmentDrawn(p, hit.k)) onRoad = true; });
          if (onRoad) continue;
          samples++;
          const drop = edge - ground.surfaceAt(x, z);
          if (drop <= FLOAT_LIMIT) continue;
          let lower = false;
          forEachRoadNear(p, x, z, 60, (hit) => { if (Math.abs(hit.k - i) > 8 && hit.h < edge - FLOAT_LIMIT) lower = true; });
          forEachSegmentNear(p, x, z, 40, (hit) => { if (Math.abs(hit.k - i) > 3 && segmentDrawn(p, hit.k)) lower = true; });
          if (uTurnAt(g, i)) lower = true;
          if (lower) { excused++; continue; }
          floating++;
          if (drop > worst) { worst = drop; where = `${(g.distance[i] / 1000).toFixed(2)} km, ${side < 0 ? 'left' : 'right'}, no verge`; }
        }
      }
    }
  }
  return { floating, detached, excused, samples, worst, where };
}

// ---- the drawn road pieces -------------------------------------------------

/** exaggeration and origin the mesh measures build with */
export const MESH_EX = 2.5;
export const MESH_ORIGIN = { x: 1234, z: -567 };

/** A route with every road chunk built, as the mesh measures need it. */
/**
 * A route's ground and every road chunk, as the window builds them. With
 * `ponds` the ground holds the route's ponds, as in the app; `kind` forces
 * one kind of land along the whole route.
 */
export function meshScene(points: LocalPoint[] | ActivityTrack, opts: { ponds?: boolean; kind?: LandKind } = {}) {
  const course = new Course(Array.isArray(points) ? trackFromLocal(points) : points);
  const g = buildGeometry(course);
  const p = buildPasses(g, buildViewProfile(course, g));
  const seed = routeSeed(g);
  const land = buildLand(g, p, seed);
  if (opts.kind) land.kind.fill(opts.kind);
  const ground = buildGround(p, seed, g, opts.ponds ? land : undefined);
  const planner = new ChunkPlanner(g, p);
  const model: SceneModel = { g, p, ground, land, seed, chunkRange: (c) => planner.chunkRange(c) };
  const chunks: RoadChunkData[] = [];
  for (let c = 0; c < planner.chunkCount; c++) chunks.push(buildRoadChunk(model, c, MESH_ORIGIN, MESH_EX));
  return { g, p, ground, model, planner, chunks };
}
export type MeshScene = ReturnType<typeof meshScene>;

/** whether (x, z) lies on (or within `pad` of) a drawn segment's footprint outside i − 1 … i + 1 */
function overOther(s: MeshScene, i: number, x: number, z: number, pad: number) {
  let over = false;
  forEachSegmentNear(s.p, x, z, ROAD_EDGE + pad, (hit) => { if ((hit.k < i - 1 || hit.k > i + 1) && segmentDrawn(s.p, hit.k)) over = true; });
  return over;
}

interface Span { ax: number; az: number; atop: number; abot: number; bx: number; bz: number; btop: number; bbot: number }

/** Every skirt quad, back in true metres, read from the arrays the GPU gets. */
export function skirtSpans(s: MeshScene): Span[] {
  const out: Span[] = [];
  const h = (y: number) => y / MESH_EX + s.ground.base;
  for (const chunk of s.chunks) {
    const q = chunk.skirts.positions;
    for (let v = 0; v < q.length; v += 18) {
      // emitted as a, a-bottom, b, a-bottom, b-bottom, b
      out.push({
        ax: q[v] + MESH_ORIGIN.x, az: q[v + 2] + MESH_ORIGIN.z, atop: h(q[v + 1]), abot: h(q[v + 4]),
        bx: q[v + 6] + MESH_ORIGIN.x, bz: q[v + 8] + MESH_ORIGIN.z, btop: h(q[v + 7]), bbot: h(q[v + 13]),
      });
    }
  }
  return out;
}

/**
 * Along every drawn edge that meets the ground (the verge's outer edge where
 * a verge is drawn, else the road's own edge), every 0.5 m: either the drawn
 * ground is not below the edge, or a skirt in the arrays stands right there
 * from the edge down to at or below the ground. Points within 0.5 m of
 * another road's footprint are left out: the skirt stops there.
 */
export function sliverViolations(s: MeshScene) {
  const { g, p, ground } = s;
  const spans = skirtSpans(s);
  const grid = new Map<string, Span[]>();
  const key = (x: number, z: number) => `${Math.floor(x / 20)},${Math.floor(z / 20)}`;
  for (const sp of spans) {
    const n = Math.ceil(Math.hypot(sp.bx - sp.ax, sp.bz - sp.az) / 2) + 1;
    for (let e = 0; e <= n; e++) {
      const k = key(sp.ax + ((sp.bx - sp.ax) * e) / n, sp.az + ((sp.bz - sp.az) * e) / n);
      const list = grid.get(k) ?? [];
      if (!list.includes(sp)) list.push(sp);
      grid.set(k, list);
    }
  }
  const covered = (x: number, z: number, top: number, floor: number) => {
    const cx = Math.floor(x / 20);
    const cz = Math.floor(z / 20);
    const near: Span[] = [];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) near.push(...(grid.get(`${cx + a},${cz + b}`) ?? []));
    for (const sp of near) {
      const dx = sp.bx - sp.ax;
      const dz = sp.bz - sp.az;
      const len2 = dx * dx + dz * dz;
      if (len2 < 1e-12) continue;
      const t = ((x - sp.ax) * dx + (z - sp.az) * dz) / len2;
      // 1 cm either way: the arrays are rounded to 1/256 m
      const slack = 0.01 / Math.sqrt(len2);
      if (t < -slack || t > 1 + slack) continue;
      if (Math.hypot(sp.ax + dx * t - x, sp.az + dz * t - z) > 0.01) continue;
      const st = sp.atop + (sp.btop - sp.atop) * t;
      const sb = sp.abot + (sp.bbot - sp.abot) * t;
      if (st >= top - 0.01 && sb <= floor) return true;
    }
    return false;
  };
  let missing = 0;
  let exposed = 0;
  let samples = 0;
  let worst = 0;
  let where = '';
  const last = VERGE_OFFSETS.length - 1;
  for (let i = 0; i + 1 < g.count; i++) {
    if (!segmentDrawn(p, i)) continue;
    const j = i + 1;
    for (const side of [-1, 1]) {
      const verge = ground.vergeWidth(i, side) > 0 || ground.vergeWidth(j, side) > 0;
      const v = verge ? last : 0;
      const ri = ground.vergeRing(i, side);
      const rj = ground.vergeRing(j, side);
      const len = Math.hypot(rj.x[v] - ri.x[v], rj.z[v] - ri.z[v]);
      const steps = Math.max(1, Math.ceil(len / 0.5));
      for (let st = 0; st <= steps; st++) {
        const t = st / steps;
        const x = ri.x[v] + (rj.x[v] - ri.x[v]) * t;
        const z = ri.z[v] + (rj.z[v] - ri.z[v]) * t;
        if (overOther(s, i, x, z, 0.5)) continue;
        samples++;
        const top = ri.h[v] + (rj.h[v] - ri.h[v]) * t;
        const floor = ground.drawnHeightAt(x, z);
        if (floor >= top - 1e-3) continue;
        exposed++;
        if (covered(x, z, top, floor)) continue;
        missing++;
        if (top - floor > worst) { worst = top - floor; where = `${(g.distance[i] / 1000).toFixed(2)} km, ${side < 0 ? 'left' : 'right'} ${verge ? 'verge' : 'road'} edge`; }
      }
    }
  }
  return { missing, exposed, samples, worst, where };
}

/**
 * Pairs of drawn segments whose footprints overlap, found by sampling one
 * footprint's interior against the other's (not with the builder's own
 * overlap test), and how many of them share a layer.
 */
export function flickerViolations(s: MeshScene) {
  const { g, p } = s;
  const layers = roadLayers(g, p);
  let pairs = 0;
  let shared = 0;
  let top = 0;
  /** strictly inside segment k's drawn quad (its two triangles), by more than 5 cm */
  const inside = (k: number, x: number, z: number) => {
    const c = (i: number, o: number): [number, number] => [p.px[i] + g.rx[i] * o, p.pz[i] + g.rz[i] * o];
    const A = c(k, -ROAD_EDGE), B = c(k, ROAD_EDGE), C = c(k + 1, -ROAD_EDGE), D = c(k + 1, ROAD_EDGE);
    const inTri = (P: [number, number], Q: [number, number], R: [number, number]) => {
      const edge = (u: [number, number], v: [number, number]) => {
        const len = Math.hypot(v[0] - u[0], v[1] - u[1]) || 1;
        return ((v[0] - u[0]) * (z - u[1]) - (v[1] - u[1]) * (x - u[0])) / len;
      };
      const e = [edge(P, Q), edge(Q, R), edge(R, P)];
      return e.every((d) => d > 0.05) || e.every((d) => d < -0.05);
    };
    return inTri(A, B, C) || inTri(B, D, C);
  };
  for (let i = 0; i + 1 < g.count; i++) {
    if (!segmentDrawn(p, i)) continue;
    top = Math.max(top, layers[i]);
    const near: number[] = [];
    forEachSegmentNear(p, (p.px[i] + p.px[i + 1]) / 2, (p.pz[i] + p.pz[i + 1]) / 2, 25, (hit) => { if (hit.k < i && segmentDrawn(p, hit.k)) near.push(hit.k); });
    for (const k of near) {
      let overlap = false;
      for (let t = 0.05; t < 1 && !overlap; t += 0.1) {
        for (let o = -ROAD_EDGE + 0.2; o <= ROAD_EDGE - 0.2 && !overlap; o += 0.5) {
          const x = p.px[i] + (p.px[i + 1] - p.px[i]) * t + (g.rx[i] + (g.rx[i + 1] - g.rx[i]) * t) * o;
          const z = p.pz[i] + (p.pz[i + 1] - p.pz[i]) * t + (g.rz[i] + (g.rz[i + 1] - g.rz[i]) * t) * o;
          if (inside(k, x, z)) overlap = true;
        }
      }
      if (!overlap) continue;
      pairs++;
      if (layers[i] === layers[k]) shared++;
    }
  }
  return { pairs, shared, top };
}

/** The vertex of `meshes` nearest (x, y, z) in scene units, as its 6 exact floats (position, normal), or undefined beyond 1 cm. */
function vertexAt(meshes: MeshData[], x: number, y: number, z: number): number[] | undefined {
  let best: number[] | undefined;
  let bestD = 0.01;
  for (const m of meshes) {
    for (let v = 0; v < m.positions.length; v += 3) {
      const d = Math.hypot(m.positions[v] - x, m.positions[v + 1] - y, m.positions[v + 2] - z);
      if (d < bestD) { bestD = d; best = [m.positions[v], m.positions[v + 1], m.positions[v + 2], m.normals[v], m.normals[v + 1], m.normals[v + 2]]; }
    }
  }
  return best;
}

function hasExactly(meshes: MeshData[], want: number[]): boolean {
  for (const m of meshes) {
    for (let v = 0; v < m.positions.length; v += 3) {
      if (Object.is(m.positions[v], want[0]) && Object.is(m.positions[v + 1], want[1]) && Object.is(m.positions[v + 2], want[2])
        && Object.is(m.normals[v], want[3]) && Object.is(m.normals[v + 1], want[4]) && Object.is(m.normals[v + 2], want[5])) return true;
    }
  }
  return false;
}

/** At every chunk boundary, the shared slice's road and verge vertices in one chunk are in the other, bit for bit, normals too. */
export function boundaryViolations(s: MeshScene) {
  const { g, p, ground } = s;
  let checked = 0;
  let differ = 0;
  let unfound = 0;
  for (let c = 0; c + 1 < s.chunks.length; c++) {
    const to = s.model.chunkRange(c)[1];
    if (!segmentDrawn(p, to - 1) || !segmentDrawn(p, to)) continue;
    const before = [...s.chunks[c].road, ...s.chunks[c].verge];
    const after = [...s.chunks[c + 1].road, ...s.chunks[c + 1].verge];
    const wanted: [number, number, number][] = [];
    for (const o of [-ROAD_EDGE, -ROAD_HALF_WIDTH, ROAD_HALF_WIDTH, ROAD_EDGE]) wanted.push([p.px[to] + g.rx[to] * o, p.ph[to], p.pz[to] + g.rz[to] * o]);
    for (const side of [-1, 1]) {
      if (ground.vergeWidth(to, side) === 0) continue;
      const r = ground.vergeRing(to, side);
      for (let v = 1; v < VERGE_OFFSETS.length; v++) wanted.push([r.x[v], r.h[v], r.z[v]]);
    }
    for (const [x, h, z] of wanted) {
      const found = vertexAt(before, x - MESH_ORIGIN.x, (h - ground.base) * MESH_EX, z - MESH_ORIGIN.z);
      checked++;
      if (!found) { unfound++; continue; }
      if (!hasExactly(after, found)) differ++;
    }
  }
  return { checked, differ, unfound };
}

/** Each drawn segment with one end on an earlier pass: that end lies on the earlier pass's asphalt. */
export function rejoinViolations(s: MeshScene) {
  const { p } = s;
  let joins = 0;
  let off = 0;
  for (let k = 0; k + 1 < p.count; k++) {
    if (!segmentDrawn(p, k) || p.repeat[k] === p.repeat[k + 1]) continue;
    const r = p.repeat[k] ? k : k + 1;
    joins++;
    let on = false;
    forEachSegmentNear(p, p.px[r], p.pz[r], ROAD_HALF_WIDTH, (hit) => { if (Math.abs(hit.k - k) > 3 && segmentDrawn(p, hit.k)) on = true; });
    if (!on) off++;
  }
  return { joins, off };
}

