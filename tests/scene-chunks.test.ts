import { setupDom } from './dom-setup';
setupDom();

const { Course } = await import('../src/activity/course');
const { buildGeometry } = await import('../src/scene/geometry');
const { buildViewProfile } = await import('../src/scene/view-profile');
const { buildPasses, drawnAt } = await import('../src/scene/passes');
const { ChunkPlanner, DETAILS_DROP } = await import('../src/scene/chunks');
const { check, report, suite } = await import('./harness');
const { trackFromLocal, walk } = await import('./scene-fixtures');
import type { LocalPoint } from './scene-fixtures';
import type { ActivityTrack } from '../src/activity/types';

function prepare(points: LocalPoint[] | ActivityTrack) {
  const course = new Course(Array.isArray(points) ? trackFromLocal(points) : points);
  const g = buildGeometry(course);
  const p = buildPasses(g, buildViewProfile(course, g));
  return { g, p, planner: new ChunkPlanner(g, p) };
}

/** A gently wandering road, so its chunks are spread out like a real route's. */
const wandering = (km: number) => walk(km * 1000, (d) => Math.sin(d / 2300) * 1.1 + Math.sin(d / 610) * 0.35, (d) => 200 + 80 * Math.sin(d / 4000), 10);

interface RunStats {
  maxChunks: number; maxTiles: number; lateChunks: number; lateTiles: number; openFrames: number;
  /** details pieces: most live at once, wanted but not live, live but beyond the drop distance, nearest road of any dropped */
  maxDetails: number; lateDetails: number; farDetails: number; nearestDrop: number;
}

/** Builds until idle at the start, then plays the whole route at 16× (9 m/s, 60 fps). */
function run(points: LocalPoint[] | ActivityTrack): RunStats {
  const { g, p, planner } = prepare(points);
  const stats: RunStats = { maxChunks: 0, maxTiles: 0, lateChunks: 0, lateTiles: 0, openFrames: 0, maxDetails: 0, lateDetails: 0, farDetails: 0, nearestDrop: Infinity };
  let at = drawnAt(g, p, 0);
  while (planner.frame(at.x, at.z).build) stats.openFrames++;
  const step = (9 * 16) / 60;
  for (let d = 0; d <= g.total; d += step) {
    at = drawnAt(g, p, d);
    const { drop } = planner.frame(at.x, at.z);
    for (const piece of drop) if (piece.kind === 'details') stats.nearestDrop = Math.min(stats.nearestDrop, planner.distanceTo(piece, at.x, at.z));
    const live = planner.live();
    stats.maxChunks = Math.max(stats.maxChunks, live.filter((x) => x.kind === 'chunk').length);
    stats.maxTiles = Math.max(stats.maxTiles, live.filter((x) => x.kind === 'tile').length);
    const details = live.filter((x) => x.kind === 'details');
    stats.maxDetails = Math.max(stats.maxDetails, details.length);
    for (const piece of details) if (planner.distanceTo(piece, at.x, at.z) > DETAILS_DROP) stats.farDetails++;
    // everything within 2.4 km, where the fog ends, must already be there; details within their build distance
    for (const piece of planner.wanted(at.x, at.z, 2400)) {
      if (!planner.isLive(piece)) { if (piece.kind === 'chunk') stats.lateChunks++; else if (piece.kind === 'tile') stats.lateTiles++; else stats.lateDetails++; }
    }
  }
  return stats;
}

suite('chunks: a 200 km route is as light as a 20 km one', () => {
  const short = run(wandering(20));
  const long = run(wandering(200));
  check('20 km: everything within 2.4 km is built before the rider gets that close', short.lateChunks + short.lateTiles === 0,
    `${short.lateChunks} chunks, ${short.lateTiles} tiles late`);
  check('200 km: the same', long.lateChunks + long.lateTiles === 0, `${long.lateChunks} chunks, ${long.lateTiles} tiles late`);
  // one fixed bound, whatever the length: 1 km tiles touching the 3.4 km drop
  // radius, and the chunks of about 7 km of winding road
  const CHUNK_BOUND = 14;
  const TILE_BOUND = 56;
  check(`20 km never holds more than ${CHUNK_BOUND} chunks and ${TILE_BOUND} tiles`, short.maxChunks <= CHUNK_BOUND && short.maxTiles <= TILE_BOUND,
    `${short.maxChunks} chunks, ${short.maxTiles} tiles`);
  check('200 km stays within the same bound', long.maxChunks <= CHUNK_BOUND && long.maxTiles <= TILE_BOUND,
    `${long.maxChunks} chunks, ${long.maxTiles} tiles`);
  check('and its peak is within one of 20 km\'s', long.maxChunks <= short.maxChunks + 1 && long.maxTiles <= short.maxTiles + 1,
    `${long.maxChunks}/${short.maxChunks} chunks, ${long.maxTiles}/${short.maxTiles} tiles`);
  check('opening takes as many frames for 200 km as for 20 km', long.openFrames === short.openFrames, `${long.openFrames} vs ${short.openFrames}`);
});

report();
