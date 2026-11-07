import type { RouteGeometry } from './geometry';
import type { Passes } from './passes';

/**
 * Which pieces of the scene must exist around the rider: 1 km road chunks
 * (100 slices of road, roadside strips and scenery) and 1 km × 1 km ground
 * tiles. Everything within 3 km is wanted; pieces are built nearest first, at
 * most one per frame, and dropped once they are 3.4 km away.
 *
 * A chunk is wanted when any of its drawn road comes within 3 km, measured
 * in space, not along the route: on the way down an out-and-back the road
 * under the rider belongs to the way up, a chunk many kilometres back.
 * A chunk made only of repeats draws nothing and is never built, so a route
 * of many laps stays as light as one lap.
 *
 * Each chunk also has a `details` piece: its grass, flowers, stones and
 * reeds (`details.ts`), small and many, so they exist only near the rider:
 * built once the chunk's road comes within DETAILS_BUILD and dropped beyond
 * DETAILS_DROP. The renderer draws them only within 80 m anyway.
 */

export const CHUNK_SLICES = 100;
export const TILE_SIZE = 1000;
export const BUILD_RADIUS = 3000;
/** pieces are dropped only beyond this, so the edge does not thrash */
const DROP_RADIUS = 3400;
/** a tile waits this much longer than a chunk at the same distance: the road
 *  within a kilometre comes before any far ground */
const TILE_PENALTY = 1000;
/** a chunk's details are built when its road is this near the rider… */
export const DETAILS_BUILD = 150;
/** …and dropped beyond this */
export const DETAILS_DROP = 250;

export type Piece = { kind: 'chunk'; index: number } | { kind: 'details'; index: number } | { kind: 'tile'; tx: number; tz: number };

export const pieceKey = (p: Piece) => (p.kind === 'chunk' ? `c${p.index}` : p.kind === 'details' ? `d${p.index}` : `t${p.tx},${p.tz}`);

interface Box { x0: number; x1: number; z0: number; z1: number }

const boxDistance = (b: Box, x: number, z: number) =>
  Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.z0 - z, 0, z - b.z1));

export class ChunkPlanner {
  readonly chunkCount: number;
  private readonly boxes: (Box | null)[] = [];
  /** each chunk's drawn road alone, without the scenery's margin */
  private readonly roads: (Box | null)[] = [];
  private readonly built = new Map<string, Piece>();

  constructor(private readonly g: RouteGeometry, p: Passes) {
    this.chunkCount = Math.max(1, Math.ceil((g.count - 1) / CHUNK_SLICES));
    for (let c = 0; c < this.chunkCount; c++) {
      const [from, to] = this.chunkRange(c);
      let box: Box | null = null;
      for (let i = from; i < to; i++) {
        // segment i → i + 1 is drawn unless both ends ride an earlier pass
        if (p.repeat[i] && p.repeat[i + 1]) continue;
        for (const j of [i, i + 1]) {
          const x = p.px[j];
          const z = p.pz[j];
          if (!box) box = { x0: x, x1: x, z0: z, z1: z };
          else { box.x0 = Math.min(box.x0, x); box.x1 = Math.max(box.x1, x); box.z0 = Math.min(box.z0, z); box.z1 = Math.max(box.z1, z); }
        }
      }
      this.roads.push(box && { ...box });
      // scenery reaches up to 120 m beside the road
      if (box) { box.x0 -= 150; box.x1 += 150; box.z0 -= 150; box.z1 += 150; }
      this.boxes.push(box);
    }
  }

  /** Slices of chunk `c`: segments from `from` to `to − 1`, so its road ends where the next one starts. */
  chunkRange(c: number): [number, number] {
    const from = c * CHUNK_SLICES;
    return [from, Math.min(this.g.count - 1, from + CHUNK_SLICES)];
  }

  /** Whether chunk `c` has anything to draw. */
  drawsAnything(c: number): boolean {
    return this.boxes[c] !== null;
  }

  /** How far piece is from (x, z): a chunk's box with its scenery margin, its details' bare road, or a tile. */
  distanceTo(piece: Piece, x: number, z: number): number {
    if (piece.kind === 'chunk' || piece.kind === 'details') {
      const box = (piece.kind === 'chunk' ? this.boxes : this.roads)[piece.index];
      return box ? boxDistance(box, x, z) : Infinity;
    }
    return boxDistance({ x0: piece.tx * TILE_SIZE, x1: (piece.tx + 1) * TILE_SIZE, z0: piece.tz * TILE_SIZE, z1: (piece.tz + 1) * TILE_SIZE }, x, z);
  }

  /**
   * Everything that should exist with the rider at (x, z), nearest first:
   * chunks and tiles within `radius`, details within DETAILS_BUILD. On a
   * tie a chunk comes before its details.
   */
  wanted(x: number, z: number, radius = BUILD_RADIUS): Piece[] {
    const out: [number, Piece][] = [];
    for (let c = 0; c < this.chunkCount; c++) {
      const d = this.distanceTo({ kind: 'chunk', index: c }, x, z);
      if (d <= radius) out.push([d, { kind: 'chunk', index: c }]);
    }
    for (let c = 0; c < this.chunkCount; c++) {
      const d = this.distanceTo({ kind: 'details', index: c }, x, z);
      if (d <= DETAILS_BUILD) out.push([d, { kind: 'details', index: c }]);
    }
    const t0x = Math.floor((x - radius) / TILE_SIZE);
    const t1x = Math.floor((x + radius) / TILE_SIZE);
    const t0z = Math.floor((z - radius) / TILE_SIZE);
    const t1z = Math.floor((z + radius) / TILE_SIZE);
    for (let tx = t0x; tx <= t1x; tx++) {
      for (let tz = t0z; tz <= t1z; tz++) {
        const piece: Piece = { kind: 'tile', tx, tz };
        const d = this.distanceTo(piece, x, z);
        if (d <= radius) out.push([d + TILE_PENALTY, piece]);
      }
    }
    out.sort((a, b) => a[0] - b[0]);
    return out.map(([, piece]) => piece);
  }

  /**
   * One frame's work with the rider at (x, z): at most one piece to build,
   * nearest first, and every built piece now too far away to keep. The
   * caller builds `build` and disposes `drop` before the next frame.
   */
  frame(x: number, z: number): { build: Piece | null; drop: Piece[] } {
    const drop: Piece[] = [];
    for (const [key, piece] of this.built) {
      if (this.distanceTo(piece, x, z) > (piece.kind === 'details' ? DETAILS_DROP : DROP_RADIUS)) { drop.push(piece); this.built.delete(key); }
    }
    let build: Piece | null = null;
    for (const piece of this.wanted(x, z)) {
      const key = pieceKey(piece);
      if (!this.built.has(key)) { build = piece; this.built.set(key, piece); break; }
    }
    return { build, drop };
  }

  /** Everything currently built. */
  live(): Piece[] {
    return [...this.built.values()];
  }

  isLive(piece: Piece): boolean {
    return this.built.has(pieceKey(piece));
  }

  /** Forgets everything, as when the renderer is torn down. */
  clear(): Piece[] {
    const all = this.live();
    this.built.clear();
    return all;
  }
}
