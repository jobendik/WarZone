/**
 * BRMap — Optimized 320×320 map with Fortnite-bright visuals.
 *
 * Performance optimizations:
 * - Trees use InstancedMesh (100+ trees = 2 draw calls: trunks + leaves)
 * - Rocks use InstancedMesh (1 draw call)
 * - Buildings use merged geometry (see Buildings.ts)
 * - Ground is a single-draw shader plane
 * - All colliders added to gameState for physics
 */

import * as THREE from 'three';
import * as YUKA from 'yuka';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { gameState } from '@/core/GameState';
import { BR_MAP_SIZE, BR_MAP_HALF, BR_MAP_MARGIN } from './BRConfig';
import { createBuilding, type Building } from './Buildings';
import { SpatialGrid } from './SpatialGrid';

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

  // ── Fortnite-style bright ground ──
  const groundMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
    },
    vertexShader: `
      varying vec2 vW;
      varying float vD;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.);
        vW = w.xz;
        vD = length(w.xz);
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      varying vec2 vW;
      varying float vD;

      float hash(vec2 p){ p=fract(p*vec2(234.34,435.345)); p+=dot(p,p+34.23); return fract(p.x*p.y); }
      float noise(vec2 p){
        vec2 i=floor(p),f=fract(p);
        float a=hash(i),b=hash(i+vec2(1.,0.)),c=hash(i+vec2(0.,1.)),d=hash(i+vec2(1.,1.));
        vec2 u=f*f*(3.-2.*f);
        return mix(a,b,u.x)+(c-a)*u.y*(1.-u.x)+(d-b)*u.x*u.y;
      }

      void main(){
        // Base grass gradient
        float n = noise(vW * 0.04) * 0.5 + noise(vW * 0.15) * 0.3 + noise(vW * 0.5) * 0.2;
        vec3 grass1 = vec3(0.28, 0.52, 0.22);  // rich green
        vec3 grass2 = vec3(0.38, 0.62, 0.30);  // lighter green
        vec3 grass3 = vec3(0.30, 0.44, 0.20);  // darker green
        vec3 col = mix(grass1, mix(grass2, grass3, n), smoothstep(0.3, 0.7, n));

        // Dirt patches
        float dirt = noise(vW * 0.08 + 42.);
        vec3 dirtCol = vec3(0.45, 0.35, 0.25);
        col = mix(col, dirtCol, smoothstep(0.68, 0.78, dirt) * 0.6);

        // Roads (along X and Z axes, wider)
        float roadX = 1. - smoothstep(3.5, 4.5, abs(vW.y));
        float roadZ = 1. - smoothstep(3.5, 4.5, abs(vW.x));
        vec3 roadCol = vec3(0.3, 0.3, 0.32);
        col = mix(col, roadCol, max(roadX, roadZ) * 0.85);

        // Road dashes
        float dashX = step(0.4, fract(vW.x * 0.1)) * roadX;
        float dashZ = step(0.4, fract(vW.y * 0.1)) * roadZ;
        col += vec3(0.7, 0.7, 0.5) * max(dashX, dashZ) * 0.12;

        // Distance fade at edges
        float edgeFade = smoothstep(140., 170., vD);
        col = mix(col, vec3(0.45, 0.55, 0.42), edgeFade * 0.5);

        gl_FragColor = vec4(col, 1.);
      }
    `,
  });
  gameState.floorMat = groundMat;

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(BR_MAP_SIZE + 60, BR_MAP_SIZE + 60),
    groundMat,
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  _brSceneObjects.push(ground);

  onProgress?.('Placing buildings...');
  await nextFrame();

  // ── Battle Royale map model (public/models/br_map.glb) ──
  // Added as visual dressing on top of the procedural terrain. Its meshes
  // are registered for AI line-of-sight raycasts (wallMeshes) so bots can
  // see/shoot through it correctly. The procedural buildings/trees/rocks
  // still provide per-object colliders and steering obstacles.
  const brMapModel = await loadBRMapModel();
  if (brMapModel) {
    scene.add(brMapModel);
    _brSceneObjects.push(brMapModel);
    brMapModel.updateMatrixWorld(true);
    let brMeshCount = 0;
    brMapModel.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!(mesh as any).isMesh) return;
      if (!(mesh as any).geometry) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      gameState.wallMeshes.push(mesh);
      brMeshCount++;
    });
    console.info(`[BRMap] Loaded br_map.glb — ${brMeshCount} meshes registered for occlusion.`);
  }

  // ── POIs ──
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

  // ── Buildings ──
  const buildings: Building[] = [];
  buildingGrid.clear();

  for (const poi of pois) {
    const count = 3 + Math.floor(Math.random() * 3); // 3-5 per POI
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const dist = 4 + Math.random() * poi.radius * 0.65;
      const bx = poi.x + Math.cos(angle) * dist;
      const bz = poi.z + Math.sin(angle) * dist;
      const w = 8 + Math.random() * 10;
      const d = 8 + Math.random() * 10;
      const floors = 1 + Math.floor(Math.random() * 3);

      if (overlaps(buildings, bx, bz, w, d)) continue;

      const b = createBuilding(bx, bz, w, d, floors);
      scene.add(b.mesh);
      _brSceneObjects.push(b.mesh);

      // Register per-wall colliders (with door gaps)
      for (const wc of b.wallColliders) {
        gameState.colliders.push({ type: 'box', x: wc.x, z: wc.z, hw: wc.hw + 0.15, hd: wc.hd + 0.15 });
        gameState.arenaColliders.push({ type: 'box', x: wc.x, z: wc.z, hw: wc.hw, hd: wc.hd });
      }

      // Register for wall raycasts (all child meshes)
      b.mesh.traverse(obj => {
        if ((obj as THREE.Mesh).isMesh) gameState.wallMeshes.push(obj as THREE.Mesh);
      });

      // No YUKA obstacle for buildings — per-wall colliders + keepInside handle it.
      // A single large circle would block bots from navigating through doorways.

      buildings.push(b);
      buildingGrid.insert(b, bx, bz);
    }
  }

  onProgress?.('Planting trees...');
  await nextFrame();

  // ── Instanced trees (1 trunk mesh + 1 leaf mesh for ALL trees) ──
  const TREE_COUNT = 120;
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 3.5, 6);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6a4a2a, roughness: 0.9 });
  const treeInstances = new THREE.InstancedMesh(trunkGeo, trunkMat, TREE_COUNT);
  treeInstances.castShadow = true;
  treeInstances.receiveShadow = false;

  const leafGeo = new THREE.ConeGeometry(2.0, 4.5, 7);
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x3a8a3a, roughness: 0.85 });
  const leafInstances = new THREE.InstancedMesh(leafGeo, leafMat, TREE_COUNT);
  leafInstances.castShadow = true;
  leafInstances.receiveShadow = false;

  const _m = new THREE.Matrix4();
  let treeIdx = 0;
  for (let i = 0; i < TREE_COUNT * 2 && treeIdx < TREE_COUNT; i++) {
    const x = (Math.random() - 0.5) * BR_MAP_SIZE * 0.92;
    const z = (Math.random() - 0.5) * BR_MAP_SIZE * 0.92;
    if (nearBuilding(buildings, x, z, 5)) continue;
    if (nearRoad(x, z)) continue;

    // Trunk
    _m.makeTranslation(x, 1.75, z);
    const scale = 0.85 + Math.random() * 0.3;
    _m.scale(new THREE.Vector3(scale, scale, scale));
    treeInstances.setMatrixAt(treeIdx, _m);
    treeInstances.setColorAt(treeIdx, new THREE.Color(0x5a3a1a + Math.floor(Math.random() * 0x101010)));

    // Leaves
    _m.makeTranslation(x, 5.2 * scale, z);
    _m.scale(new THREE.Vector3(scale, scale, scale));
    leafInstances.setMatrixAt(treeIdx, _m);
    const green = 0x2a7a2a + Math.floor(Math.random() * 0x003000);
    leafInstances.setColorAt(treeIdx, new THREE.Color(green));

    // Collider (simple circle)
    gameState.colliders.push({ type: 'circle', x, z, r: 0.6 });
    gameState.arenaColliders.push({ type: 'circle', x, z, r: 0.5 });

    treeIdx++;
  }
  treeInstances.count = treeIdx;
  leafInstances.count = treeIdx;
  treeInstances.instanceMatrix.needsUpdate = true;
  leafInstances.instanceMatrix.needsUpdate = true;
  if (treeInstances.instanceColor) treeInstances.instanceColor.needsUpdate = true;
  if (leafInstances.instanceColor) leafInstances.instanceColor.needsUpdate = true;
  scene.add(treeInstances);
  scene.add(leafInstances);
  _brSceneObjects.push(treeInstances, leafInstances);

  onProgress?.('Scattering rocks...');
  await nextFrame();

  // ── Instanced rocks ──
  const ROCK_COUNT = 60;
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.9, flatShading: true });
  const rockInstances = new THREE.InstancedMesh(rockGeo, rockMat, ROCK_COUNT);
  rockInstances.castShadow = true;
  rockInstances.receiveShadow = true;

  let rockIdx = 0;
  for (let i = 0; i < ROCK_COUNT * 2 && rockIdx < ROCK_COUNT; i++) {
    const x = (Math.random() - 0.5) * BR_MAP_SIZE * 0.92;
    const z = (Math.random() - 0.5) * BR_MAP_SIZE * 0.92;
    if (nearBuilding(buildings, x, z, 4)) continue;

    const r = 0.6 + Math.random() * 1.0;
    _m.makeTranslation(x, r * 0.45, z);
    _m.scale(new THREE.Vector3(r, r * 0.7, r));
    const rot = new THREE.Matrix4().makeRotationY(Math.random() * Math.PI * 2);
    _m.multiply(rot);
    rockInstances.setMatrixAt(rockIdx, _m);
    rockInstances.setColorAt(rockIdx, new THREE.Color(0x6a6a6a + Math.floor(Math.random() * 0x202020)));

    gameState.colliders.push({ type: 'circle', x, z, r: r * 0.8 });
    gameState.arenaColliders.push({ type: 'circle', x, z, r: r * 0.7 });

    rockIdx++;
  }
  rockInstances.count = rockIdx;
  rockInstances.instanceMatrix.needsUpdate = true;
  if (rockInstances.instanceColor) rockInstances.instanceColor.needsUpdate = true;
  scene.add(rockInstances);
  _brSceneObjects.push(rockInstances);

  // ── Boundary (soft wall) ──
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

  // ── Cover points near buildings ──
  for (const b of buildings) {
    for (const off of [[b.hw + 1.2, 0], [-b.hw - 1.2, 0], [0, b.hd + 1.2], [0, -b.hd - 1.2]]) {
      const px = b.cx + off[0];
      const pz = b.cz + off[1];
      if (Math.abs(px) < BR_MAP_MARGIN && Math.abs(pz) < BR_MAP_MARGIN) {
        gameState.coverPoints.push(new YUKA.Vector3(px, 0, pz));
      }
    }
  }

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

function overlaps(buildings: Building[], x: number, z: number, w: number, d: number): boolean {
  for (const b of buildings) {
    if (Math.abs(b.cx - x) < (b.width + w) / 2 + 2 && Math.abs(b.cz - z) < (b.depth + d) / 2 + 2) return true;
  }
  return false;
}

function nearBuilding(buildings: Building[], x: number, z: number, pad: number): boolean {
  for (const b of buildings) {
    if (Math.abs(b.cx - x) < b.hw + pad && Math.abs(b.cz - z) < b.hd + pad) return true;
  }
  return false;
}

function nearRoad(x: number, z: number): boolean {
  return Math.abs(x) < 5 || Math.abs(z) < 5;
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
}
