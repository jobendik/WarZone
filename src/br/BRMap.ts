/**
 * BRMap — Battle Royale map loaded exclusively from `public/models/br_map.glb`.
 *
 * Earlier revisions layered procedurally generated buildings/trees/rocks and
 * a shader ground plane on top of the glb. That produced three problems:
 *   1. Hundreds of extra meshes + colliders crushed perf to ~1 FPS.
 *   2. The shader plane at y=0 fought with the glb's actual floor height,
 *      so the player (pinned to y=0 on landing) walked on a different
 *      surface than the AI bots (who snap to the `br_navmesh.glb` floor).
 *   3. When `br_navmesh.glb` sits at a non-zero Y, player `collidesPlayer`
 *      couldn't find a region (vertical epsilon), so the player was stuck.
 *
 * The fix: load only the glb, let `br_navmesh.glb` define the walkable
 * surface Y, and let player landing / bot landing snap to that navmesh Y.
 */

import * as THREE from 'three';
import * as YUKA from 'yuka';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { gameState } from '@/core/GameState';
import { BR_MAP_SIZE, BR_MAP_HALF } from './BRConfig';
import type { Building } from './Buildings';
import { SpatialGrid } from './SpatialGrid';

// ── BVH acceleration for BR wall/occlusion meshes ──
// Arena.ts installs three-mesh-bvh's patched Mesh.prototype.raycast globally
// and builds boundsTrees on every arena mesh. Without boundsTrees on the BR
// meshes, LOS raycasts (Perception.isOccluded, Hitscan, hearing, etc.) fall
// back to O(triangles) per mesh per ray. br_map.glb ships with 276 meshes
// and ~420k triangles, so with ~29 bots doing multiple LOS raycasts per
// frame the cost explodes to a few FPS. Building a BVH per mesh fixes it.
function tryBuildBVH(geom: THREE.BufferGeometry | undefined): void {
  if (!geom) return;
  if ((geom as any).boundsTree) return;
  const fn = (geom as any).computeBoundsTree as ((opts?: unknown) => void) | undefined;
  if (typeof fn !== 'function') return;
  // Skinned / morph-target / degenerate meshes are unsupported by three-mesh-bvh;
  // fall back with a warning so those rays still work (just slower on that mesh).
  try {
    fn.call(geom);
  } catch (err) {
    console.warn('[BRMap] BVH build failed for mesh', (geom as any).name, err);
  }
}

function tryDisposeBVH(geom: THREE.BufferGeometry | undefined): void {
  if (!geom) return;
  const fn = (geom as any).disposeBoundsTree as (() => void) | undefined;
  if (typeof fn !== 'function') return;
  try { fn.call(geom); } catch { /* ignore */ }
}

const BR_MAP_MODEL_URL = `${import.meta.env.BASE_URL}models/br_map.glb`;
const brMapLoader = new GLTFLoader();

function loadBRMapModel(): Promise<THREE.Group | null> {
  return new Promise((resolve) => {
    brMapLoader.load(
      BR_MAP_MODEL_URL,
      (gltf) => {
        const root = gltf.scene;
        root.name = 'BRMapRenderModel';
        resolve(root);
      },
      undefined,
      (err) => {
        console.warn(`[BRMap] Failed to load ${BR_MAP_MODEL_URL} — falling back to procedural map only.`, err);
        resolve(null);
      },
    );
  });
}

export interface BRMapData {
  buildings: Building[];
  pois: { name: string; x: number; z: number; radius: number }[];
  treeInstances: THREE.InstancedMesh;
  leafInstances: THREE.InstancedMesh;
  rockInstances: THREE.InstancedMesh;
}

let _mapData: BRMapData | null = null;
export function getBRMapData(): BRMapData | null { return _mapData; }

// Spatial grid for buildings (used by loot, bots, collision)
export const buildingGrid = new SpatialGrid<Building>();

// ── BR scene tracking for proper teardown ──
let _brSceneObjects: THREE.Object3D[] = [];
let _brColliderStart = 0;
let _brArenaColliderStart = 0;
let _brWallMeshStart = 0;
let _brCoverPointStart = 0;
let _prevFog: THREE.FogBase | null = null;
let _prevBackground: THREE.Color | THREE.Texture | null = null;
let _prevFloorMat: THREE.ShaderMaterial | null = null;

function nextFrame(): Promise<void> {
  return new Promise(r => requestAnimationFrame(() => r()));
}

export async function buildBRMap(onProgress?: (msg: string) => void): Promise<BRMapData> {
  const { scene } = gameState;

  // Snapshot shared state so we can restore it on dispose
  _prevFog = scene.fog;
  _prevBackground = scene.background as THREE.Color | THREE.Texture | null;
  _prevFloorMat = gameState.floorMat;
  _brColliderStart = gameState.colliders.length;
  _brArenaColliderStart = gameState.arenaColliders.length;
  _brWallMeshStart = gameState.wallMeshes.length;
  _brCoverPointStart = gameState.coverPoints.length;
  _brSceneObjects = [];

  // The map visual + collision geometry comes entirely from br_map.glb now.
  // We do NOT add a procedural ground plane — the glb ships with its own
  // terrain, and a y=0 plane would hover above/below the real surface and
  // cause the player to walk on a different floor than the navmesh-bound AI.
  gameState.floorMat = null;

  onProgress?.('Loading map model...');
  await nextFrame();

  // ── Battle Royale map model (public/models/br_map.glb) ──
  // All walkable geometry, decoration and occluders live inside the glb.
  // Every mesh is registered for AI line-of-sight raycasts (wallMeshes) and
  // gets a BVH so LOS calls stay O(log n) rather than O(triangles).
  const brMapModel = await loadBRMapModel();
  if (brMapModel) {
    scene.add(brMapModel);
    _brSceneObjects.push(brMapModel);
    brMapModel.updateMatrixWorld(true);
    let brMeshCount = 0;
    let brBvhBuilt = 0;
    brMapModel.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!(mesh as any).isMesh) return;
      const geom = (mesh as any).geometry as THREE.BufferGeometry | undefined;
      if (!geom) return;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      const hadBefore = !!(geom as any).boundsTree;
      tryBuildBVH(geom);
      if (!hadBefore && (geom as any).boundsTree) brBvhBuilt++;
      gameState.wallMeshes.push(mesh);
      brMeshCount++;
    });
    console.info(`[BRMap] Loaded br_map.glb — ${brMeshCount} meshes registered for occlusion (BVH built on ${brBvhBuilt}).`);
  } else {
    console.warn('[BRMap] br_map.glb failed to load — the match will have no map geometry.');
  }

  // ── POIs ──
  // Named areas used for bot spawn distribution and loot placement. These
  // are logical points only — the physical geometry is in the glb.
  const pois = [
    { name: 'Pleasant Park', x: -100, z: -90, radius: 28 },
    { name: 'Retail Row', x: 110, z: -35, radius: 25 },
    { name: 'Tilted Towers', x: 0, z: 0, radius: 24 },
    { name: 'Salty Springs', x: -70, z: 70, radius: 20 },
    { name: 'Dusty Depot', x: 80, z: 110, radius: 22 },
    { name: 'Lonely Lodge', x: -120, z: 30, radius: 18 },
    { name: 'Junk Junction', x: 30, z: -120, radius: 16 },
    { name: 'Snobby Shores', x: 130, z: 130, radius: 20 },
  ];

  // No procedural buildings. `buildingGrid` stays empty; callers handle
  // `queryRadius()` returning 0 hits by falling back to navmesh / POIs.
  const buildings: Building[] = [];
  buildingGrid.clear();

  // ── Boundary (soft wall) ──
  // Keeps bots and the player inside the playable area even though the
  // glb may extend further. Expressed as colliders so keepInside pushes
  // agents back; `collidesPlayer` uses the same boundary via getWorldBoundary.
  for (const [bx, bz, bw, bd] of [
    [0, -BR_MAP_HALF - 1.5, BR_MAP_SIZE + 3, 3] as const,
    [0, BR_MAP_HALF + 1.5, BR_MAP_SIZE + 3, 3] as const,
    [-BR_MAP_HALF - 1.5, 0, 3, BR_MAP_SIZE + 3] as const,
    [BR_MAP_HALF + 1.5, 0, 3, BR_MAP_SIZE + 3] as const,
  ]) {
    gameState.colliders.push({ type: 'box', x: bx, z: bz, hw: bw / 2, hd: bd / 2 });
    gameState.arenaColliders.push({ type: 'box', x: bx, z: bz, hw: bw / 2, hd: bd / 2 });
  }

  onProgress?.('Setting up lighting...');
  await nextFrame();

  // ── Fortnite lighting ──
  buildBRLights();

  // ── Cover points at each POI ──
  // Without procedural buildings we derive cover points from POIs instead:
  // four compass offsets per POI give bots something to fall back to during
  // endgame hold evaluation. AI combat goals can still find cover from
  // wallMeshes raycasts against the glb.
  for (const poi of pois) {
    const r = Math.max(4, poi.radius * 0.35);
    for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
      gameState.coverPoints.push(new YUKA.Vector3(poi.x + dx, 0, poi.z + dz));
    }
  }

  // Empty instanced meshes kept to preserve BRMapData shape for other
  // modules (they all use `.count` which is 0 here — a no-op).
  const emptyInstances = (): THREE.InstancedMesh => new THREE.InstancedMesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ visible: false }),
    0,
  );
  const treeInstances = emptyInstances();
  const leafInstances = emptyInstances();
  const rockInstances = emptyInstances();

  _mapData = { buildings, pois, treeInstances, leafInstances, rockInstances };
  return _mapData;
}

function buildBRLights(): void {
  const { scene } = gameState;

  // Bright, warm sun
  const ambient = new THREE.AmbientLight(0xc8d8e8, 0.65);
  const hemi = new THREE.HemisphereLight(0x88bbee, 0x446633, 0.7);
  scene.add(ambient);
  scene.add(hemi);
  _brSceneObjects.push(ambient, hemi);

  const sun = new THREE.DirectionalLight(0xfff0d0, 2.8);
  sun.position.set(60, 120, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.camera.left = -100;
  sun.shadow.camera.right = 100;
  sun.shadow.camera.top = 100;
  sun.shadow.camera.bottom = -100;
  sun.shadow.camera.far = 300;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  scene.add(sun);
  _brSceneObjects.push(sun);

  // Softer fill from opposite side
  const fill = new THREE.DirectionalLight(0x8899bb, 0.6);
  fill.position.set(-40, 50, -30);
  scene.add(fill);
  _brSceneObjects.push(fill);

  // Bright fog — Fortnite uses light blue haze, not dark
  scene.fog = new THREE.FogExp2(0xb0c8e0, 0.003);
  scene.background = new THREE.Color(0x78a8d8);
}

export function disposeBRMap(): void {
  const { scene } = gameState;

  // Remove all BR scene objects and dispose their resources
  for (const obj of _brSceneObjects) {
    scene.remove(obj);
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh) {
        tryDisposeBVH((mesh as any).geometry as THREE.BufferGeometry | undefined);
        mesh.geometry?.dispose();
        if (Array.isArray(mesh.material)) {
          for (const m of mesh.material) m.dispose();
        } else if (mesh.material) {
          mesh.material.dispose();
        }
      }
    });
  }
  _brSceneObjects = [];

  // Restore shared arrays to pre-BR state
  gameState.colliders.length = _brColliderStart;
  gameState.arenaColliders.length = _brArenaColliderStart;
  gameState.wallMeshes.length = _brWallMeshStart;
  gameState.coverPoints.length = _brCoverPointStart;

  // Restore scene environment
  scene.fog = _prevFog;
  scene.background = _prevBackground;
  gameState.floorMat = _prevFloorMat;

  buildingGrid.clear();
  _mapData = null;
}
