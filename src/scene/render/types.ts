import type { RouteGeometry } from '../geometry';
import type { Ground } from '../ground';
import type { Passes } from '../passes';
import type { Land } from '../landscape';
import type { Piece } from '../chunks';
import type { Vec3 } from '../pose';

/**
 * What the window hands the renderer, and what the renderer offers back. This
 * file never imports `three`, so the window, its tests and their fake
 * renderer can all use it without pulling three.js in.
 */

/** Everything the scene is made from, all of it pure data built in the window. */
export interface SceneModel {
  g: RouteGeometry;
  p: Passes;
  ground: Ground;
  /** the kind of land beside every slice */
  land: Land;
  seed: number;
  /** slices of chunk `c` */
  chunkRange(c: number): [number, number];
}

export interface FrameView {
  /** the rider's point on the road, scene units (heights exaggerated, before re-basing); only used to re-base */
  rider: Vec3;
  /** the first-person eye */
  camera: { position: Vec3; target: Vec3 };
}

export const RESOLUTIONS = { chunky: 480, medium: 640, fine: 960 } as const;
export type Resolution = keyof typeof RESOLUTIONS;
export const DEFAULT_RESOLUTION: Resolution = 'medium';

export interface SceneRenderer {
  /** the canvas it draws into, for the window to place */
  readonly canvas: HTMLCanvasElement;
  /** internal width in pixels (480, 640 or 960); height follows at 16:9 */
  setResolution(width: number): void;
  /** heights are drawn as (h − base) × exaggeration; changing it drops every piece */
  setExaggeration(exaggeration: number): void;
  build(piece: Piece): void;
  drop(piece: Piece): void;
  /** drops every piece */
  clear(): void;
  render(view: FrameView): void;
  /** called once if the browser takes the WebGL context away */
  onContextLost(listener: () => void): void;
  /** frees every geometry, material and texture, and the context itself */
  dispose(): void;
}

/** Thrown, as `code`, when a WebGL context cannot be created. */
export class NoWebGLError extends Error {
  readonly code = 'no-webgl';
  constructor() { super('WebGL is not available'); }
}

export type RendererLoader = () => Promise<(model: SceneModel, exaggeration: number) => SceneRenderer>;
