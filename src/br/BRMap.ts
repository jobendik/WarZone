/**
 * BRMap — Loads a pre-built GLB map and navmesh for Battle Royale.
 *
 * Previously this module procedurally generated the entire 320×320 map
 * (ground plane, buildings, trees, rocks). Now it loads:
 *   - br_simpleMap.glb      → visual render model
 *   - br_simpleMapNavmesh.glb → YUKA navmesh for bot pathfinding
 *
 * All meshes from the GLB are registered for LOS raycasts (wallMeshes)
 * with BVH acceleration, identical to how Arena.ts handles tdm_map.glb.
 */

import * as THREE from 'three';
import * as YUKA from 'yuka';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  computeBoundsTree,
  disposeBoundsTree,
  acceleratedRaycast,
} from 'three-mesh-bvh';
import { gameState } from '@/core/GameState';
import { BR_MAP_SIZE, BR_MAP_HALF, BR_MAP_MARGIN } from './BRConfig';
import { SpatialGrid } from './SpatialGrid';
import type { Building } from './Buildings';
import { initDynamicWeather, disposeDynamicWeather } from '@/world/DynamicWeather';

// Ensure BVH-accelerated raycasting is installed (Arena.ts does this too,
// but it's idempotent, so safe to repeat here in case BR loads first).
(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
(THREE.Mesh.prototype as any).raycast = acceleratedRaycast;

const BASE_URL = import.meta.env.BASE_URL;
const BR_MAP_MODEL_URL = `${BASE_URL}models/br_simpleMap.glb`;
const BR_NAV_MODEL_URL = `${BASE_URL}models/br_simpleMapNavmesh.glb`;

const loader = new GLTFLoader();

export interface BRMapData {
  pois: { name: string; x: number; z: number; radius: number }[];
}

let _mapData: BRMapData | null = null;
export function getBRMapData(): BRMapData | null { return _mapData; }

// Spatial grid for buildings (used by loot, bots, collision).
// Kept as an export for API compatibility — will be empty since
// buildings are now baked into the GLB.
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

  // ── Load the BR render model ──
  onProgress?.('Loading map model...');
  await nextFrame();

  const mapRoot = await loadGLB(BR_MAP_MODEL_URL);
  mapRoot.name = 'BRMapRenderModel';
  scene.add(mapRoot);
  _brSceneObjects.push(mapRoot);

  // Register every mesh for shadow + LOS raycasts (same as Arena.ts)
  let meshCount = 0;
  let bvhBuiltCount = 0;
  mapRoot.updateMatrixWorld(true);
  mapRoot.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as any).isMesh) return;
    if (!(mesh as any).geometry) return;

    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Build BVH for fast raycasts
    const geom = mesh.geometry as THREE.BufferGeometry;
    const isSkinned = (mesh as any).isSkinnedMesh === true;
    const hasMorph = !!(geom as any)?.morphAttributes &&
                     Object.keys((geom as any).morphAttributes).length > 0;
    if (!isSkinned && !hasMorph) {
      try {
        (geom as any).computeBoundsTree();
        bvhBuiltCount++;
      } catch (err) {
        console.warn('[BRMap] BVH build failed for mesh', mesh.name, err);
      }
    }

    gameState.wallMeshes.push(mesh);
    meshCount++;
  });

  console.info(
    `[BRMap] Loaded ${BR_MAP_MODEL_URL} — ` +
    `${meshCount} meshes registered for occlusion raycasts (BVH: ${bvhBuiltCount})`
  );

  // ── Load the BR navmesh ──
  onProgress?.('Loading navmesh...');
  await nextFrame();

  try {
    await gameState.navMeshManager.load(BR_NAV_MODEL_URL);
    console.info(
      `[BRMap] NavMesh loaded: ${gameState.navMeshManager.navMesh?.regions.length ?? 0} regions`
    );
  } catch (err) {
    console.warn('[BRMap] Failed to load BR navmesh — bots will wander without pathfinding.', err);
  }

  // ── POIs — kept for loot spawning and bot navigation ──
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

  // ── Boundary colliders (soft wall at map edges) ──
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

  // ── Fortnite-style lighting ──
  const ambient = new THREE.AmbientLight(0xc8d8e8, 0.65);
  const hemi = new THREE.HemisphereLight(0x88bbee, 0x446633, 0.7);
  scene.add(ambient);
  scene.add(hemi);
  _brSceneObjects.push(ambient, hemi);

  const sun = new THREE.DirectionalLight(0xfff0d0, 2.8);
  sun.position.set(100, 150, 50);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 1024;
  sun.shadow.mapSize.height = 1024;
  sun.shadow.camera.left = -160;
  sun.shadow.camera.right = 160;
  sun.shadow.camera.top = 160;
  sun.shadow.camera.bottom = -160;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 350;
  sun.shadow.bias = -0.0002;
  scene.add(sun);
  _brSceneObjects.push(sun);

  initDynamicWeather(scene, ambient, sun, gameState.camera, 'clear');

  // ── Cover points from navmesh regions (scatter near POIs) ──
  for (const poi of pois) {
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2;
      const px = poi.x + Math.cos(angle) * (poi.radius * 0.6);
      const pz = poi.z + Math.sin(angle) * (poi.radius * 0.6);
      if (Math.abs(px) < BR_MAP_MARGIN && Math.abs(pz) < BR_MAP_MARGIN) {
        gameState.coverPoints.push(new YUKA.Vector3(px, 0, pz));
      }
    }
  }

  _mapData = { pois };
  return _mapData;
}

function loadGLB(url: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => resolve(gltf.scene),
      undefined,
      reject,
    );
  });
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
  disposeDynamicWeather();
}
