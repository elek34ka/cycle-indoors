import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DodecahedronGeometry,
  DoubleSide,
  Fog,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three';
import { pieceKey } from '../chunks';
import { buildRoadChunk, ROAD_LAYERS } from '../mesh/road-mesh';
import { buildPondWater, buildTerrainTile, shiftPositions, type MeshData } from '../mesh/terrain-mesh';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { placeScenery, type SceneryItem, type SceneryKind } from '../scenery';
import { DEFAULT_PALETTE, type SceneryPart } from '../palette';
import { NoWebGLError, type FrameView, type SceneModel, type SceneRenderer } from './types';

/**
 * The only module that imports three.js. It wraps the pure mesh builders'
 * arrays (`src/scene/mesh/`) in buffers and draws them at a low internal
 * resolution, scaled up with hard pixel edges by CSS. Every spatial rule
 * lives in those pure modules and is tested there; this file only draws.
 *
 * Every piece's vertices are relative to one shared integer origin and drawn
 * with an identity matrix, so the vertices two pieces share are the same
 * floats in both. When the origin moves, every live buffer is shifted in
 * place by the integer difference, which is exact (`shiftPositions`).
 */

const SKY = 0x9fc6e8;
const FOG_NEAR = 700;
/** the fog ends here, inside the 3 km the chunks cover, so their edge is never seen */
const FOG_FAR = 2400;
/** the origin moves to the rider once they are this far from it, so float32
 *  vertex positions stay precise however long the route */
const REBASE_DISTANCE = 2000;
/** with no rider model nothing is nearer than the road 1.5 m below the eye */
const NEAR_PLANE = 0.5;
/** scenery nearer the camera than this is not drawn; it fades in up to FADE_FAR */
const FADE_NEAR = 6;
const FADE_FAR = 10;
/** trunks reach this far into the ground, so a small slope never shows a gap */
const SINK = 0.4;

/**
 * A material drawn `level` steps nearer than the ground in depth, so where
 * two surfaces coincide the higher level always wins: verges over the
 * lattice, road layers over verges and each other, markings over all.
 */
function layered<M extends Material>(material: M, level: number): M {
  if (level > 0) {
    material.polygonOffset = true;
    material.polygonOffsetFactor = -level;
    material.polygonOffsetUnits = -4 * level;
  }
  return material;
}

/**
 * Scenery fades out near the camera by an ordered (Bayer 4×4) dither in the
 * fragment shader: nothing within FADE_NEAR, thinning in up to FADE_FAR. It
 * works for instanced meshes at no CPU cost and suits the pixel look.
 */
function withNearFade<M extends Material>(material: M): M {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFadeWorld;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 fadeWorld = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          fadeWorld = instanceMatrix * fadeWorld;
        #endif
        vFadeWorld = (modelMatrix * fadeWorld).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vFadeWorld;
        float bayer2(vec2 q) { return 2.0 * q.x + 3.0 * q.y - 4.0 * q.x * q.y; }
        float bayer4(vec2 p) {
          vec2 q = mod(floor(p), 4.0);
          return (4.0 * bayer2(mod(q, 2.0)) + bayer2(floor(q / 2.0)) + 0.5) / 16.0;
        }`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        float fadeDistance = distance(vFadeWorld, cameraPosition);
        if (fadeDistance < ${FADE_NEAR.toFixed(1)}) discard;
        if ((fadeDistance - ${FADE_NEAR.toFixed(1)}) / ${(FADE_FAR - FADE_NEAR).toFixed(1)} < bayer4(gl_FragCoord.xy)) discard;`);
  };
  material.customProgramCacheKey = () => 'near-fade';
  return material;
}

interface Built {
  objects: (Mesh | InstancedMesh)[];
  /** moves every vertex and instance by the integer change of origin */
  shift: (dx: number, dz: number) => void;
  dispose: () => void;
}

function geometryFrom(data: MeshData): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
  geometry.setAttribute('color', new BufferAttribute(data.colours, 3));
  geometry.setIndex(new BufferAttribute(data.index, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function shiftGeometry(geometry: BufferGeometry, dx: number, dz: number): void {
  const position = geometry.getAttribute('position') as BufferAttribute;
  shiftPositions(position.array as Float32Array, dx, dz);
  position.needsUpdate = true;
  geometry.computeBoundingSphere();
}

export function createSceneRenderer(model: SceneModel, initialExaggeration: number): SceneRenderer {
  const canvas = document.createElement('canvas');
  canvas.className = 'scene-canvas';
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power' });
  } catch {
    throw new NoWebGLError();
  }
  renderer.setPixelRatio(1);
  renderer.setSize(640, 360, false);

  const { g, p, ground, land, seed } = model;
  const pal = DEFAULT_PALETTE;
  let exaggeration = initialExaggeration;
  const Y = (h: number) => (h - ground.base) * exaggeration;
  let ox = 0;
  let oz = 0;

  const scene = new Scene();
  scene.background = new Color(SKY);
  scene.fog = new Fog(SKY, FOG_NEAR, FOG_FAR);
  scene.add(new HemisphereLight(0xdfefff, 0x4a5a2a, 1.6));
  const sun = new DirectionalLight(0xfff0d0, 1.6);
  sun.position.set(0.4, 1, 0.25);
  scene.add(sun);
  const camera = new PerspectiveCamera(60, 16 / 9, NEAR_PLANE, 3200);

  // shared materials and scenery shapes, freed once on dispose; ground and road smooth-shaded
  const groundMaterial = new MeshLambertMaterial({ vertexColors: true });
  const skirtMaterial = new MeshLambertMaterial({ vertexColors: true, side: DoubleSide });
  const vergeMaterials = Array.from({ length: ROAD_LAYERS }, (_, k) => layered(new MeshLambertMaterial({ vertexColors: true, side: DoubleSide }), 1 + k));
  const roadMaterials = Array.from({ length: ROAD_LAYERS }, (_, k) => layered(new MeshLambertMaterial({ vertexColors: true, side: DoubleSide }), 1 + ROAD_LAYERS + k));
  const waterMaterial = new MeshLambertMaterial({ vertexColors: true });
  const markingMaterial = layered(new MeshBasicMaterial({ vertexColors: true, side: DoubleSide }), 1 + 2 * ROAD_LAYERS);
  // every tree, bush, rock and post: one white material, coloured per instance from the palette
  const sceneryMaterial = withNearFade(new MeshLambertMaterial({ color: 0xffffff, flatShading: true }));
  const allMaterials: Material[] = [groundMaterial, skirtMaterial, ...vergeMaterials, ...roadMaterials, markingMaterial, waterMaterial, sceneryMaterial];
  const trunk = (bottom: number, top: number, height: number) =>
    new CylinderGeometry(top, bottom, height + SINK, 5).translate(0, (height + SINK) / 2 - SINK, 0);
  /** a branch: a thin box from the trunk at height h, leaning out by `lean` radians toward `turn` */
  const branch = (h: number, length: number, lean: number, turn: number) =>
    new BoxGeometry(0.12, length, 0.12).translate(0, length / 2, 0).rotateZ(lean).rotateY(turn).translate(0, h, 0);
  const shapes = {
    trunk: trunk(0.32, 0.22, 3),
    pine: new ConeGeometry(2.1, 6.5, 6).translate(0, 5.4, 0),
    spruce: mergeGeometries([
      new ConeGeometry(2.2, 3.6, 7).translate(0, 3.4, 0),
      new ConeGeometry(1.6, 3.2, 7).translate(0, 5.4, 0),
      new ConeGeometry(1, 2.6, 7).translate(0, 7.2, 0),
    ]),
    leaves: new IcosahedronGeometry(2.6, 0).translate(0, 4.6, 0),
    oakTrunk: trunk(0.48, 0.36, 2.6),
    oak: new IcosahedronGeometry(3.2, 0).scale(1, 0.72, 1).translate(0, 4.7, 0),
    birchTrunk: trunk(0.18, 0.13, 5.4),
    birch: new IcosahedronGeometry(1.6, 0).scale(0.85, 1.45, 0.85).translate(0, 5.6, 0),
    poplarTrunk: trunk(0.26, 0.2, 2),
    poplar: new IcosahedronGeometry(1.4, 0).scale(0.8, 3.3, 0.8).translate(0, 6.2, 0),
    deadTrunk: trunk(0.3, 0.16, 5),
    branches: mergeGeometries([branch(2.6, 2.2, 0.75, 0), branch(3.4, 1.8, 0.7, 2.2), branch(4.1, 1.5, 0.6, 4.2)]),
    bush: new IcosahedronGeometry(1.1, 0).translate(0, 0.6, 0),
    rock: new DodecahedronGeometry(1.1, 0).scale(1, 0.6, 1).translate(0, 0.3, 0),
    post: new BoxGeometry(0.14, 1.1 + SINK, 0.14).translate(0, (1.1 + SINK) / 2 - SINK, 0),
  };
  /** what each kind of scenery is made of: [shape, the palette colour it takes] */
  const parts: Record<SceneryKind, [BufferGeometry, SceneryPart][]> = {
    pine: [[shapes.trunk, 'trunk'], [shapes.pine, 'pine']],
    spruce: [[shapes.trunk, 'trunk'], [shapes.spruce, 'spruce']],
    broadleaf: [[shapes.trunk, 'trunk'], [shapes.leaves, 'leaves']],
    oak: [[shapes.oakTrunk, 'trunk'], [shapes.oak, 'oak']],
    birch: [[shapes.birchTrunk, 'paleTrunk'], [shapes.birch, 'birch']],
    poplar: [[shapes.poplarTrunk, 'trunk'], [shapes.poplar, 'poplar']],
    dead: [[shapes.deadTrunk, 'branches'], [shapes.branches, 'branches']],
    bush: [[shapes.bush, 'bush']],
    rock: [[shapes.rock, 'rock']],
    post: [[shapes.post, 'post']],
  };

  const pieces = new Map<string, Built>();

  /** Meshes over the given arrays; empty arrays make no mesh. */
  function meshes(list: [MeshData, Material][]): Mesh[] {
    const out: Mesh[] = [];
    for (const [data, material] of list) {
      if (data.index.length === 0) continue;
      const mesh = new Mesh(geometryFrom(data), material);
      mesh.matrixAutoUpdate = false; // identity: vertices are already at the shared origin
      out.push(mesh);
    }
    return out;
  }

  function scenery(from: number, to: number): InstancedMesh[] {
    const items = placeScenery(g, p, ground, land, seed, from, to);
    const byKind = new Map<SceneryKind, SceneryItem[]>();
    for (const it of items) {
      const list = byKind.get(it.kind);
      if (list) list.push(it); else byKind.set(it.kind, [it]);
    }
    const out: InstancedMesh[] = [];
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const pos = new Vector3();
    const scale = new Vector3();
    const tinted = new Color();
    for (const [kind, list] of byKind) {
      for (const [shape, part] of parts[kind]) {
        const mesh = new InstancedMesh(shape, sceneryMaterial, list.length);
        mesh.matrixAutoUpdate = false;
        const [r, gr, b] = pal.scenery[part];
        list.forEach((it, n) => {
          q.setFromAxisAngle(up, it.turn);
          pos.set(it.x - ox, Y(it.y), it.z - oz);
          scale.setScalar(it.scale);
          mesh.setMatrixAt(n, m.compose(pos, q, scale));
          // a little lighter or darker per item, so no two neighbours are the same
          const shade = 0.85 + 0.3 * it.tint;
          mesh.setColorAt(n, tinted.setRGB(Math.min(1, r * shade), Math.min(1, gr * shade), Math.min(1, b * shade)));
        });
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.computeBoundingSphere();
        out.push(mesh);
      }
    }
    return out;
  }

  function assemble(objects: (Mesh | InstancedMesh)[]): Built {
    return {
      objects,
      shift(dx, dz) {
        for (const object of objects) {
          if (object instanceof InstancedMesh) {
            const e = object.instanceMatrix.array as Float32Array;
            for (let k = 0; k < e.length; k += 16) { e[k + 12] -= dx; e[k + 14] -= dz; }
            object.instanceMatrix.needsUpdate = true;
            object.computeBoundingSphere();
          } else {
            shiftGeometry(object.geometry, dx, dz);
          }
        }
      },
      dispose() {
        for (const object of objects) {
          if (object instanceof InstancedMesh) object.dispose();
          else object.geometry.dispose();
        }
      },
    };
  }

  function buildChunk(c: number): Built {
    const [from, to] = model.chunkRange(c);
    const origin = { x: ox, z: oz };
    const data = buildRoadChunk(model, c, origin, exaggeration, pal);
    const list: [MeshData, Material][] = [
      [data.skirts, skirtMaterial],
      ...data.verge.map((d, k) => [d, vergeMaterials[k]] as [MeshData, Material]),
      ...data.road.map((d, k) => [d, roadMaterials[k]] as [MeshData, Material]),
      [data.markings, markingMaterial],
    ];
    return assemble([...meshes(list), ...scenery(from, to)]);
  }

  function buildTile(tx: number, tz: number): Built {
    const origin = { x: ox, z: oz };
    return assemble(meshes([
      [buildTerrainTile(model, tx, tz, origin, exaggeration, pal), groundMaterial],
      [buildPondWater(model, tx, tz, origin, exaggeration, pal), waterMaterial],
    ]));
  }

  const lostListeners: (() => void)[] = [];
  let disposed = false;
  const onLost = (event: Event) => {
    event.preventDefault();
    if (disposed) return;
    for (const listener of lostListeners) listener();
  };
  canvas.addEventListener('webglcontextlost', onLost);

  const api: SceneRenderer = {
    canvas,
    setResolution(width) {
      renderer.setSize(width, Math.round((width * 9) / 16), false);
    },
    setExaggeration(value) {
      if (value === exaggeration) return;
      exaggeration = value;
      api.clear();
    },
    build(piece) {
      const key = pieceKey(piece);
      if (pieces.has(key)) return;
      const built = piece.kind === 'chunk' ? buildChunk(piece.index) : buildTile(piece.tx, piece.tz);
      for (const object of built.objects) scene.add(object);
      pieces.set(key, built);
    },
    drop(piece) {
      const key = pieceKey(piece);
      const built = pieces.get(key);
      if (!built) return;
      for (const object of built.objects) scene.remove(object);
      built.dispose();
      pieces.delete(key);
    },
    clear() {
      for (const built of pieces.values()) { for (const object of built.objects) scene.remove(object); built.dispose(); }
      pieces.clear();
    },
    render(view: FrameView) {
      const [rx, , rz] = view.rider;
      if (Math.hypot(rx - ox, rz - oz) > REBASE_DISTANCE) {
        const nx = Math.round(rx);
        const nz = Math.round(rz);
        for (const built of pieces.values()) built.shift(nx - ox, nz - oz);
        ox = nx;
        oz = nz;
      }
      const [cx, cy, cz] = view.camera.position;
      const [tx, ty, tz] = view.camera.target;
      camera.position.set(cx - ox, cy, cz - oz);
      camera.lookAt(tx - ox, ty, tz - oz);
      renderer.render(scene, camera);
    },
    onContextLost(listener) {
      lostListeners.push(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      api.clear();
      for (const shape of Object.values(shapes)) shape.dispose();
      for (const material of allMaterials) material.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.removeEventListener('webglcontextlost', onLost);
    },
  };
  return api;
}
