import { setupDom } from './dom-setup';
setupDom();

const { parseGpx } = await import('../src/activity/gpx');
const { readFileSync } = await import('node:fs');
const { forEachSegmentNear } = await import('../src/scene/passes');
const { ROAD_EDGE } = await import('../src/scene/ground');
const { shiftPositions } = await import('../src/scene/mesh/terrain-mesh');
const { buildRoadChunk, ROAD_LAYERS } = await import('../src/scene/mesh/road-mesh');
const { check, report, suite } = await import('./harness');
const { meshScene, sliverViolations, flickerViolations, boundaryViolations, rejoinViolations, skirtSpans, MESH_EX, MESH_ORIGIN } = await import('./scene-seams');
const { outAndBack, hairpin, switchback, eastbound, walk } = await import('./scene-fixtures');
import type { LocalPoint } from './scene-fixtures';
import type { ActivityTrack } from '../src/activity/types';
import type { MeshData } from '../src/scene/mesh/terrain-mesh';

const routes: [string, LocalPoint[] | ActivityTrack][] = [
  ['eastbound, rolling', eastbound(3000, (d) => 100 + 20 * Math.sin(d / 300))],
  ['a road crossing the lattice at 30°, climbing 6%', walk(2000, () => Math.PI / 6, (d) => 100 + 0.06 * d)],
  ['hairpin, legs 30 m apart', hairpin(600, 30, 0)],
  ['U-turn, legs 12 m apart', hairpin(600, 12, 0)],
  ['switchback, upper road 40 m beside and 25 m above', switchback(600, 40, 25)],
  ['out-and-back, 8% climb', outAndBack(1500, 8, 1)],
  ['sample loop', parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'Sample')],
];

for (const [name, points] of routes) {
  const s = meshScene(points);
  suite(`road mesh: ${name}`, () => {
    const sl = sliverViolations(s);
    check('no sliver: wherever the ground is below an edge, a skirt stands there from the edge down into the ground',
      sl.missing === 0 && sl.samples > 0, `${sl.missing} of ${sl.exposed} exposed (${sl.samples} samples), worst ${sl.worst.toFixed(2)} m at ${sl.where}`);
    const f = flickerViolations(s);
    check(`no flicker: overlapping segments never share a layer (${f.pairs} overlapping pairs)`, f.shared === 0, `${f.shared} share`);
    check(`at most ${ROAD_LAYERS} layers`, f.top < ROAD_LAYERS, `${f.top + 1}`);
    const b = boundaryViolations(s);
    if (b.checked > 0) check(`chunk boundaries: shared slices match bit for bit, normals too (${b.checked} vertices)`, b.differ === 0 && b.unfound === 0, `${b.differ} differ, ${b.unfound} not found`);
    const r = rejoinViolations(s);
    if (r.joins > 0) check(`rejoins: every transition starts on the earlier pass's asphalt (${r.joins})`, r.off === 0, `${r.off} off`);
  });
}

suite('road mesh: overlap and rejoins are exercised', () => {
  const s = meshScene(outAndBack(1500, 8, 1));
  check('the out-and-back has rejoining transitions', rejoinViolations(s).joins > 0);
  const u = meshScene(parseGpx(readFileSync('samples/sample-hilly-loop.gpx', 'utf8'), 'Sample'));
  check('the sample loop has chunk boundaries to compare', boundaryViolations(u).checked > 0);
});

suite('road mesh: moving the origin', () => {
  const s = meshScene(switchback(600, 40, 25));
  const moved = { x: MESH_ORIGIN.x - 3001, z: MESH_ORIGIN.z + 1777 };
  const fresh = buildRoadChunk(s.model, 0, moved, MESH_EX);
  const old = s.chunks[0];
  const pairs: [MeshData, MeshData][] = [
    ...old.road.map((m, k) => [m, fresh.road[k]] as [MeshData, MeshData]),
    ...old.verge.map((m, k) => [m, fresh.verge[k]] as [MeshData, MeshData]),
    [old.markings, fresh.markings],
    [old.skirts, fresh.skirts],
  ];
  let differ = 0;
  let floats = 0;
  for (const [a, b] of pairs) {
    const shifted = Float32Array.from(a.positions);
    shiftPositions(shifted, moved.x - MESH_ORIGIN.x, moved.z - MESH_ORIGIN.z);
    if (shifted.length !== b.positions.length) { differ++; continue; }
    floats += shifted.length;
    for (let v = 0; v < shifted.length; v++) if (!Object.is(shifted[v], b.positions[v])) differ++;
  }
  check(`a shifted chunk equals one built at the new origin, bit for bit (${floats} floats)`, differ === 0 && floats > 0, `${differ} differ`);
});

suite('road mesh: a road crossing 6 m above another', () => {
  // east along z = 0 at 100 m; round and up to 106 m; then south across the first road at x = 500
  const pts: LocalPoint[] = [];
  for (let x = 0; x <= 1000; x += 5) pts.push({ x, z: 0, ele: 100 });
  for (let z = -5; z >= -300; z -= 5) pts.push({ x: 1000, z, ele: 100 + Math.min(6, (-z / 150) * 6) });
  for (let x = 995; x >= 500; x -= 5) pts.push({ x, z: -300, ele: 106 });
  for (let z = -295; z <= 300; z += 5) pts.push({ x: 500, z, ele: 106 });
  const s = meshScene(pts);
  const { p } = s;
  // the lower road's segment under the crossing and the upper road's over it
  let lower = -1;
  let upper = -1;
  forEachSegmentNear(p, 500, 0, 3, (hit) => { if (lower < 0 || hit.k < lower) lower = hit.k; if (hit.k > upper) upper = hit.k; });
  check('the fixture crosses: two passes at (500, 0)', lower >= 0 && upper - lower > 10);
  const rise = p.ph[upper] - p.ph[lower];
  check(`the upper road is at least 4 m above the lower one (${rise.toFixed(1)} m)`, rise >= 4);
  let over = 0;
  let near = 0;
  for (const sp of skirtSpans(s)) {
    for (let t = 0; t <= 1; t += 0.05) {
      const x = sp.ax + (sp.bx - sp.ax) * t;
      const z = sp.az + (sp.bz - sp.az) * t;
      const h = sp.atop + (sp.btop - sp.atop) * t;
      if (Math.hypot(x - 500, z) < 30 && h > p.ph[lower] + 2) near++;
      // strictly inside the lower road's footprint, by more than the skirt's step
      if (Math.abs(z) < ROAD_EDGE - 0.6 && Math.abs(x - 500) < 20 && h > p.ph[lower] + 2) over++;
    }
  }
  check('the upper road has skirts beside the crossing (an embankment, not a floating road)', near > 0, `${near}`);
  check('none of them stands over the lower road', over === 0, `${over} points over it`);
  const sl = sliverViolations(s);
  check('and no sliver anywhere else', sl.missing === 0, `${sl.missing}, worst ${sl.worst.toFixed(2)} at ${sl.where}`);
});

report();
