import { CELL, GROUND_MARGIN, ROAD_EDGE, VERGE_OFFSETS } from '../ground';
import type { RouteGeometry } from '../geometry';
import { forEachSegmentNear, ROAD_HALF_WIDTH, segmentDrawn, type Passes } from '../passes';
import type { SceneModel } from '../render/types';
import { DEFAULT_PALETTE, landColour, type Palette } from '../palette';
import { quantise, speckle, type MeshData, type Origin } from './terrain-mesh';

/**
 * Vertex data for one road chunk, as the GPU gets it (no three.js here):
 * - asphalt and shoulder per depth layer, so where two stretches of road
 *   overlap the same one is always drawn over the other;
 * - the verges on each side, in their segment's layer, drawn under every
 *   road layer and over the ground;
 * - the markings, drawn over every layer;
 * - skirts: from a verge's outer edge down into the ground where the ground
 *   is lower, and from the road's edge where no verge is drawn.
 *
 * Coordinates are rounded and made relative to the shared integer origin
 * exactly as the ground tiles are (`quantise`), so a slice two chunks share
 * has bit-identical vertices in both, and so do their normals and colours.
 */

/** how many depth layers road surfaces get; overlapping segments never share one */
export const ROAD_LAYERS = 4;
/** a skirt reaches this far below the lowest ground along its edge (true metres) */
const SKIRT_DEPTH = GROUND_MARGIN + 0.2;
/** how finely a skirt looks for other roads along its edge, metres */
const SKIRT_STEP = 0.5;

/**
 * Fractions along a → b (xz, true metres) where the drawn ground can bend:
 * the ends, every SKIRT_STEP, and every crossing of a lattice line
 * (x = n·CELL, z = n·CELL) or a cell's diagonal (x + z = n·CELL). The drawn
 * ground is linear between them, so its lowest point along the line, and
 * any place it dips below a straight edge, is at one of them.
 */
export function skirtStops(ax: number, az: number, bx: number, bz: number): number[] {
  const out = [0, 1];
  const len = Math.hypot(bx - ax, bz - az);
  for (let s = 1; s * SKIRT_STEP < len; s++) out.push((s * SKIRT_STEP) / len);
  const cross = (v0: number, v1: number) => {
    const lo = Math.min(v0, v1) / CELL;
    const hi = Math.max(v0, v1) / CELL;
    if (hi - lo < 1e-12) return;
    for (let n = Math.floor(lo) + 1; n < hi; n++) out.push((n * CELL - v0) / (v1 - v0));
  };
  cross(ax, bx);
  cross(az, bz);
  cross(ax + az, bx + bz);
  return out.filter((t) => t >= 0 && t <= 1).sort((a, b) => a - b);
}

const ASPHALT: [number, number, number] = [0.33, 0.34, 0.37];
const GRAVEL: [number, number, number] = [0.52, 0.48, 0.4];
const EARTH: [number, number, number] = [0.42, 0.36, 0.27];
const PAINT: [number, number, number] = [0.95, 0.95, 0.92];

export interface RoadChunkData {
  /** asphalt and shoulder, one per layer (some may be empty) */
  road: MeshData[];
  /** verges, one per layer */
  verge: MeshData[];
  markings: MeshData;
  skirts: MeshData;
}

class Builder {
  positions: number[] = [];
  normals: number[] = [];
  colours: number[] = [];
  vertex(p: [number, number, number], n: [number, number, number], c: [number, number, number]): void {
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    this.colours.push(c[0], c[1], c[2]);
  }
  /** Two triangles a–b–c and b–d–c: a→b across, a→c along. */
  quad(v: [number, number, number][], n: [number, number, number][], c: [number, number, number][]): void {
    for (const k of [0, 1, 2, 1, 3, 2]) this.vertex(v[k], n[k], c[k]);
  }
  done(): MeshData {
    const count = this.positions.length / 3;
    const index = new Uint32Array(count);
    for (let k = 0; k < count; k++) index[k] = k;
    return { positions: new Float32Array(this.positions), normals: new Float32Array(this.normals), colours: new Float32Array(this.colours), index };
  }
}

// ---- depth layers -----------------------------------------------------------

type P2 = [number, number];

/** The footprint of segment k (asphalt and shoulder) as two triangles, in xz. */
function footprint(g: RouteGeometry, p: Passes, k: number): [P2, P2, P2][] {
  const c = (i: number, o: number): P2 => [p.px[i] + g.rx[i] * o, p.pz[i] + g.rz[i] * o];
  const a = c(k, -ROAD_EDGE);
  const b = c(k, ROAD_EDGE);
  const cc = c(k + 1, -ROAD_EDGE);
  const d = c(k + 1, ROAD_EDGE);
  return [[a, b, cc], [b, d, cc]];
}

/** Whether two triangles share area (not just an edge or a corner): separating axes with a 1 cm allowance. */
function trianglesOverlap(s: [P2, P2, P2], t: [P2, P2, P2]): boolean {
  const area = (q: [P2, P2, P2]) => Math.abs((q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[2][0] - q[0][0]) * (q[1][1] - q[0][1]));
  if (area(s) < 1e-6 || area(t) < 1e-6) return false;
  for (const tri of [s, t]) {
    for (let e = 0; e < 3; e++) {
      const [x1, z1] = tri[e];
      const [x2, z2] = tri[(e + 1) % 3];
      const len = Math.hypot(x2 - x1, z2 - z1);
      if (len < 1e-9) continue;
      const nx = -(z2 - z1) / len;
      const nz = (x2 - x1) / len;
      const proj = (q: [P2, P2, P2]) => q.map(([x, z]) => x * nx + z * nz);
      const ps = proj(s);
      const pt = proj(t);
      const gap = Math.min(Math.max(...ps) - Math.min(...pt), Math.max(...pt) - Math.min(...ps));
      if (gap <= 0.01) return false;
    }
  }
  return true;
}

/** Whether drawn segments a and b overlap anywhere on the ground. */
export function segmentsOverlap(g: RouteGeometry, p: Passes, a: number, b: number): boolean {
  for (const s of footprint(g, p, a)) for (const t of footprint(g, p, b)) if (trianglesOverlap(s, t)) return true;
  return false;
}

const layerCache = new WeakMap<Passes, Uint8Array>();

/**
 * Every drawn segment's depth layer, greedy in route order: the lowest layer
 * no earlier segment it overlaps already has. Worked out once per route, so a
 * segment's layer is the same whichever chunk draws it.
 */
export function roadLayers(g: RouteGeometry, p: Passes): Uint8Array {
  const cached = layerCache.get(p);
  if (cached) return cached;
  const layers = new Uint8Array(Math.max(0, p.count - 1));
  const near: number[] = [];
  for (let i = 0; i + 1 < p.count; i++) {
    if (!segmentDrawn(p, i)) continue;
    near.length = 0;
    const mx = (p.px[i] + p.px[i + 1]) / 2;
    const mz = (p.pz[i] + p.pz[i + 1]) / 2;
    forEachSegmentNear(p, mx, mz, 2 * ROAD_EDGE + 12, (hit) => { if (hit.k < i && segmentDrawn(p, hit.k)) near.push(hit.k); });
    const used = new Set<number>();
    for (const k of near) if (segmentsOverlap(g, p, i, k)) used.add(layers[k]);
    let layer = 0;
    while (used.has(layer) && layer < ROAD_LAYERS - 1) layer++;
    layers[i] = layer;
  }
  layerCache.set(p, layers);
  return layers;
}

// ---- the chunk --------------------------------------------------------------

/** Drawn rise over run at slice i, from its neighbours. */
function slopeAt(g: RouteGeometry, p: Passes, i: number): number {
  const a = Math.max(0, i - 1);
  const b = Math.min(p.count - 1, i + 1);
  const run = g.distance[b] - g.distance[a];
  return run > 0 ? (p.ph[b] - p.ph[a]) / run : 0;
}

export function buildRoadChunk(model: SceneModel, c: number, origin: Origin, exaggeration: number, pal: Palette = DEFAULT_PALETTE): RoadChunkData {
  const { g, p, ground, land, seed } = model;
  const [from, to] = model.chunkRange(c);
  const layers = roadLayers(g, p);
  const Y = (h: number) => (h - ground.base) * exaggeration;
  const at = (x: number, z: number, h: number): [number, number, number] => [quantise(x) - origin.x, Y(h), quantise(z) - origin.z];
  const point = (i: number, lateral: number, h = p.ph[i]) => at(p.px[i] + g.rx[i] * lateral, p.pz[i] + g.rz[i] * lateral, h);
  /** slice i's surface normal: tilted with the drawn slope, level across */
  const normal = (i: number): [number, number, number] => {
    const s = slopeAt(g, p, i) * exaggeration;
    const len = Math.hypot(s, 1);
    return [(-s * g.tx[i]) / len, 1 / len, (-s * g.tz[i]) / len];
  };
  const shade = (i: number, colour: [number, number, number], amount = 0.08): [number, number, number] => {
    const s = 1 - amount / 2 + amount * speckle(seed, i, 7);
    return [colour[0] * s, colour[1] * s, colour[2] * s];
  };

  const road = Array.from({ length: ROAD_LAYERS }, () => new Builder());
  const verge = Array.from({ length: ROAD_LAYERS }, () => new Builder());
  const marks = new Builder();
  const skirts = new Builder();

  /** Whether (x, z) lies on a drawn segment's footprint other than segment i's own neighbourhood. */
  const overOtherRoad = (i: number, x: number, z: number) => {
    let over = false;
    forEachSegmentNear(p, x, z, ROAD_EDGE, (hit) => { if ((hit.k < i - 1 || hit.k > i + 1) && segmentDrawn(p, hit.k)) over = true; });
    return over;
  };

  /**
   * Skirts below the edge a → b ([x, height, z], true metres), each down to
   * SKIRT_DEPTH under the lowest drawn ground along it. Left out where the
   * ground is nowhere lower than the edge, and over another road (a road
   * crossing underneath, or the one this rejoins): the edge is split there
   * and each stretch beside it gets its own skirt.
   */
  const skirt = (i: number, a: [number, number, number], b: [number, number, number], outward: [number, number]) => {
    const n: [number, number, number] = [outward[0], 0, outward[1]];
    const stops = skirtStops(a[0], a[2], b[0], b[2]);
    let first = -1;
    let lowest = Infinity;
    let exposed = false;
    const close = (last: number) => {
      if (first >= 0 && exposed && last > first) {
        const t0 = stops[first];
        const t1 = stops[last];
        const pt = (t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        const [x0, h0, z0] = t0 === 0 ? a : pt(t0);
        const [x1, h1, z1] = t1 === 1 ? b : pt(t1);
        const bottom = lowest - SKIRT_DEPTH;
        skirts.quad([at(x0, z0, h0), at(x0, z0, bottom), at(x1, z1, h1), at(x1, z1, bottom)], [n, n, n, n], [EARTH, EARTH, EARTH, EARTH]);
      }
      first = -1;
      lowest = Infinity;
      exposed = false;
    };
    stops.forEach((t, s) => {
      const x = a[0] + (b[0] - a[0]) * t;
      const z = a[2] + (b[2] - a[2]) * t;
      if (overOtherRoad(i, x, z)) { close(s - 1); return; }
      if (first < 0) first = s;
      const h = ground.drawnHeightAt(x, z);
      if (h < a[1] + (b[1] - a[1]) * t) exposed = true;
      lowest = Math.min(lowest, h);
    });
    close(stops.length - 1);
  };

  for (let i = from; i < to; i++) {
    if (!segmentDrawn(p, i)) continue;
    const j = i + 1;
    const layer = layers[i];
    const ni = normal(i);
    const nj = normal(j);
    const N4 = [ni, ni, nj, nj];

    // asphalt across, then the two shoulders
    const asphaltI = shade(i, ASPHALT);
    const asphaltJ = shade(j, ASPHALT);
    road[layer].quad([point(i, -ROAD_HALF_WIDTH), point(i, ROAD_HALF_WIDTH), point(j, -ROAD_HALF_WIDTH), point(j, ROAD_HALF_WIDTH)], N4, [asphaltI, asphaltI, asphaltJ, asphaltJ]);
    const gravelI = shade(i, GRAVEL, 0.14);
    const gravelJ = shade(j, GRAVEL, 0.14);
    road[layer].quad([point(i, -ROAD_EDGE), point(i, -ROAD_HALF_WIDTH), point(j, -ROAD_EDGE), point(j, -ROAD_HALF_WIDTH)], N4, [gravelI, gravelI, gravelJ, gravelJ]);
    road[layer].quad([point(i, ROAD_HALF_WIDTH), point(i, ROAD_EDGE), point(j, ROAD_HALF_WIDTH), point(j, ROAD_EDGE)], N4, [gravelI, gravelI, gravelJ, gravelJ]);

    // edge lines, and a dashed centre line: 5 m painted in every 10
    const white: [number, number, number][] = [PAINT, PAINT, PAINT, PAINT];
    for (const e of [-ROAD_HALF_WIDTH + 0.25, ROAD_HALF_WIDTH - 0.25]) {
      marks.quad([point(i, e - 0.08), point(i, e + 0.08), point(j, e - 0.08), point(j, e + 0.08)], N4, white);
    }
    const half = (lateral: number): [number, number, number] => {
      const x = (p.px[i] + p.px[j]) / 2 + ((g.rx[i] + g.rx[j]) / 2) * lateral;
      const z = (p.pz[i] + p.pz[j]) / 2 + ((g.rz[i] + g.rz[j]) / 2) * lateral;
      return at(x, z, (p.ph[i] + p.ph[j]) / 2);
    };
    marks.quad([point(i, -0.08), point(i, 0.08), half(-0.08), half(0.08)], N4, white);

    for (const side of [-1, 1]) {
      const wi = ground.vergeWidth(i, side);
      const wj = ground.vergeWidth(j, side);
      const ri = ground.vergeRing(i, side);
      const rj = ground.vergeRing(j, side);
      const outward: [number, number] = [g.rx[i] * side, g.rz[i] * side];
      if (wi === 0 && wj === 0) {
        // no verge: the road's own side goes down into the ground
        skirt(i, [ri.x[0], ri.h[0], ri.z[0]], [rj.x[0], rj.h[0], rj.z[0]], outward);
        continue;
      }
      const tint = (k: number) => {
        const s = 0.92 + 0.12 * speckle(seed, k, side < 0 ? 3 : 5);
        const b = landColour(pal, land.weights(k));
        return [b[0] * s, b[1] * s, b[2] * s] as [number, number, number];
      };
      const ci = tint(i);
      const cj = tint(j);
      for (let v = 0; v + 1 < VERGE_OFFSETS.length; v++) {
        const inner = [at(ri.x[v], ri.z[v], ri.h[v]), at(rj.x[v], rj.z[v], rj.h[v])];
        const outer = [at(ri.x[v + 1], ri.z[v + 1], ri.h[v + 1]), at(rj.x[v + 1], rj.z[v + 1], rj.h[v + 1])];
        // the first band, next to the shoulder, is gravel; the rest the land's colour
        const gi = v === 0 ? shade(i, GRAVEL, 0.1) : ci;
        const gj = v === 0 ? shade(j, GRAVEL, 0.1) : cj;
        // both sides split on the outer(i)–inner(j) diagonal, as surfaceAt assumes,
        // and wind facing up: on the left that means going along before across
        if (side > 0) verge[layer].quad([inner[0], outer[0], inner[1], outer[1]], N4, [gi, gi, gj, gj]);
        else verge[layer].quad([inner[0], inner[1], outer[0], outer[1]], [ni, nj, ni, nj], [gi, gj, gi, gj]);
      }
      const last = VERGE_OFFSETS.length - 1;
      skirt(i, [ri.x[last], ri.h[last], ri.z[last]], [rj.x[last], rj.h[last], rj.z[last]], outward);
    }
  }

  return {
    road: road.map((b) => b.done()),
    verge: verge.map((b) => b.done()),
    markings: marks.done(),
    skirts: skirts.done(),
  };
}
