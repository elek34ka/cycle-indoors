import { finaliseTrack } from '../src/activity/types';
import type { ActivityTrack, TrackPoint } from '../src/activity/types';

/**
 * Synthetic routes for the 3D view's suites, described in local metres
 * (x east, z south, as the scene uses) and turned into GPS points around a
 * fixed origin, so they go through the same parsing-free path as a GPX would.
 */

const ORIGIN = { lat: 50, lon: 19 };
const M_PER_DEG = (6371008.8 * Math.PI) / 180;

export interface LocalPoint { x: number; z: number; ele?: number }

export function trackFromLocal(points: LocalPoint[], name = 'Synthetic'): ActivityTrack {
  const kx = M_PER_DEG * Math.cos((ORIGIN.lat * Math.PI) / 180);
  const pts: TrackPoint[] = points.map((p) => ({
    lat: ORIGIN.lat - p.z / M_PER_DEG,
    lon: ORIGIN.lon + p.x / kx,
    ele: p.ele,
    distance: 0,
  }));
  return finaliseTrack(name, 'gpx', pts);
}

/** A path walked in 5 m steps: `heading(d)` in radians (0 = east, π/2 = south), `ele(d)` in metres. */
export function walk(length: number, heading: (d: number) => number, ele: (d: number) => number | undefined, step = 5): LocalPoint[] {
  const out: LocalPoint[] = [];
  let x = 0;
  let z = 0;
  for (let d = 0; d <= length + 1e-9; d += step) {
    out.push({ x, z, ele: ele(d) });
    const h = heading(d);
    x += Math.cos(h) * step;
    z += Math.sin(h) * step;
  }
  return out;
}

/** Straight east, `length` metres, with a given elevation function. */
export const eastbound = (length: number, ele: (d: number) => number | undefined = () => 100) =>
  walk(length, () => 0, ele);

/**
 * Up a road and back down it: `climb` metres east at `grade`%, a tight
 * turnaround, then the same road back, offset `gap` metres to the side.
 */
export function outAndBack(climb = 1500, grade = 8, gap = 1): LocalPoint[] {
  const up: LocalPoint[] = [];
  for (let d = 0; d <= climb; d += 5) up.push({ x: d, z: 0, ele: 100 + (d * grade) / 100 });
  const top = 100 + (climb * grade) / 100;
  // a small loop at the top, like a turning circle
  const turn: LocalPoint[] = [];
  for (let a = 1; a < 12; a++) {
    const t = (a / 12) * Math.PI;
    turn.push({ x: climb + Math.sin(t) * (gap / 2 + 4), z: gap / 2 - Math.cos(t) * (gap / 2), ele: top });
  }
  const down: LocalPoint[] = [];
  for (let d = climb; d >= 0; d -= 5) down.push({ x: d, z: gap, ele: 100 + (d * grade) / 100 });
  return [...up, ...turn, ...down];
}

/**
 * A hairpin: `leg` metres east, a half circle of radius `gap / 2`, `leg`
 * metres back west, `gap` metres to the south. The second leg climbs `rise`
 * metres over its length, so it ends above the first.
 */
export function hairpin(leg = 600, gap = 30, rise = 0): LocalPoint[] {
  const out: LocalPoint[] = [];
  for (let d = 0; d <= leg; d += 5) out.push({ x: d, z: 0, ele: 100 });
  const r = gap / 2;
  for (let a = 1; a < 16; a++) {
    const t = (a / 16) * Math.PI;
    out.push({ x: leg + Math.sin(t) * r, z: r - Math.cos(t) * r, ele: 100 });
  }
  for (let d = leg; d >= 0; d -= 5) out.push({ x: d, z: gap, ele: 100 + (rise * (leg - d)) / leg });
  return out;
}

/** A switchback: an upper road `gap` metres beside the lower one and `rise` metres above it. */
export const switchback = (leg = 600, gap = 40, rise = 25) => hairpin(leg, gap, rise);

/** Seeded random numbers, so a failing random case can be reproduced. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
