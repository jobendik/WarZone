import * as THREE from 'three';
import * as YUKA from 'yuka';
import { gameState } from '@/core/GameState';
import { ARENA_HALF } from '@/config/constants';
import { FP } from '@/config/player';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  computeBoundsTree,
  disposeBoundsTree,
  acceleratedRaycast,
} from 'three-mesh-bvh';

// Install BVH-accelerated raycasting globally on THREE.Mesh.
// Without this, every isOccluded() call raycasts every triangle of every wall
// mesh — with 66 meshes this destroys frame-rate once bots engage.
(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
(THREE.Mesh.prototype as any).raycast = acceleratedRaycast;

const arenaMeshes: THREE.Object3D[] = [];
const ARENA_MODEL_URL = `${import.meta.env.BASE_URL}models/tdm_map.glb`;
const arenaLoader = new GLTFLoader();

/**
 * Build the arena: floor, boundary rings, walls, pillars, and team bases.
 */
export async function buildArena(): Promise<void> {
  const { scene, wallMeshes, colliders, arenaColliders, yukaObs, entityManager, coverPoints } = gameState;

  for (const mesh of arenaMeshes) {
    scene.remove(mesh);
  }
  arenaMeshes.length = 0;

  for (const obstacle of yukaObs) {
    entityManager.remove(obstacle);
  }

  wallMeshes.length = 0;
  colliders.length = 0;
  arenaColliders.length = 0;
  yukaObs.length = 0;
  coverPoints.length = 0;
  gameState.floorMat = null;

  // Procedural arena generation is intentionally disabled.
  // The shipped level now comes only from arena.glb plus the baked arena_navmesh.gltf.
  const arenaRenderModel = await loadArenaRenderModel();
  scene.add(arenaRenderModel);
  arenaMeshes.push(arenaRenderModel);

  // Register every mesh (including SkinnedMesh) in the arena model for:
  //   - shadow casting / receiving
  //   - AI line-of-sight raycasts via gameState.wallMeshes (Perception.isOccluded)
  // Only real triangular THREE.Mesh objects count — Line/LineSegments/Points
  // don't occlude rays reliably (threshold-based, no triangle tests), and if
  // they leak into `wallMeshes` the raycast treats them as misses, letting
  // bots see/shoot through walls that happen to share a parent with decorative
  // line geometry.
  let meshCount = 0;
  let skippedNoGeom = 0;
  let skippedNonTri = 0;
  let bvhBuiltCount = 0;
  arenaRenderModel.updateMatrixWorld(true);
  arenaRenderModel.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    const isRealMesh = (mesh as any).isMesh === true;
    const hasGeom = !!(mesh as any).geometry;
    if (!isRealMesh) {
      // LineSegments / Points / decorative primitives — skip them entirely
      // so they don't pollute LOS/hitscan results.
      if ((obj as any).isLine || (obj as any).isLineSegments || (obj as any).isPoints) {
        skippedNonTri++;
      }
      return;
    }
    if (!hasGeom) {
      skippedNoGeom++;
      return;
    }

    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Build a BVH for this mesh so isOccluded()/Hitscan raycasts are O(log n)
    // per ray rather than O(triangles). Skinned/morph-target meshes are
    // unsupported — those skip BVH and fall back to default raycast.
    const geom = (mesh as any).geometry as THREE.BufferGeometry | undefined;
    const isSkinned = (mesh as any).isSkinnedMesh === true;
    const hasMorph = !!(geom as any)?.morphAttributes &&
                     Object.keys((geom as any).morphAttributes).length > 0;
    if (geom && !isSkinned && !hasMorph) {
      try {
        (geom as any).computeBoundsTree();
        bvhBuiltCount++;
      } catch (err) {
        console.warn('[Arena] BVH build failed for mesh', mesh.name, err);
      }
    }

    wallMeshes.push(mesh);
    meshCount++;
  });

  console.info(
    `[Arena] Using baked arena model from ${ARENA_MODEL_URL} — ` +
    `${meshCount} meshes registered for occlusion raycasts ` +
    `(BVH built on ${bvhBuiltCount}, skipped ${skippedNoGeom} mesh-like nodes with no geometry, ` +
    `${skippedNonTri} non-triangular primitives)`
  );
}

function loadArenaRenderModel(): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    arenaLoader.load(
      ARENA_MODEL_URL,
      (gltf) => {
        const root = gltf.scene;
        root.name = 'ArenaRenderModel';
        resolve(root);
      },
      undefined,
      reject,
    );
  });
}

/**
 * Add a wall (box collider + mesh) to the scene.
 */
function addWall(x: number, y: number, z: number, w: number, h: number, d: number): void {
  const { scene, wallMeshes, colliders, arenaColliders, yukaObs, entityManager } = gameState;

  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({
      color: 0x101e32, roughness: 0.85, metalness: 0.15, emissive: 0x060e1c, emissiveIntensity: 0.3,
    }),
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  arenaMeshes.push(mesh);

  mesh.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry),
      new THREE.LineBasicMaterial({ color: 0x1e4480, transparent: true, opacity: 0.4 }),
    ),
  );

  // Top accent stripe
  const stripe = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.04, 0.06, d + 0.04),
    new THREE.MeshBasicMaterial({ color: 0x1e4480, transparent: true, opacity: 0.5 }),
  );
  stripe.position.y = h * 0.5;
  mesh.add(stripe);

  wallMeshes.push(mesh);
  colliders.push({ type: 'box', x, z, hw: w * 0.5 + FP.playerRadius, hd: d * 0.5 + FP.playerRadius });
  arenaColliders.push({ type: 'box', x, z, hw: w * 0.5 + 0.45, hd: d * 0.5 + 0.45 });

  const ob = new YUKA.GameEntity();
  ob.position.set(x, 0.5, z);
  ob.boundingRadius = Math.min(w, d) * 0.5 + 0.35;
  yukaObs.push(ob);
  entityManager.add(ob);
}

/**
 * Add a cylindrical pillar to the scene.
 */
function addPillar(x: number, y: number, z: number, r: number): void {
  const { scene, wallMeshes, colliders, arenaColliders, yukaObs, entityManager } = gameState;

  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r * 1.08, 3.2, 10),
    new THREE.MeshStandardMaterial({ color: 0x182e4a, roughness: 0.65, metalness: 0.2, emissive: 0x0a1830, emissiveIntensity: 0.2 }),
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  arenaMeshes.push(mesh);

  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(r + 0.05, r + 0.05, 0.08, 10),
    new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.4 }),
  );
  band.position.y = 0.8;
  mesh.add(band);

  // Second band near base
  const band2 = new THREE.Mesh(
    new THREE.CylinderGeometry(r + 0.05, r + 0.05, 0.06, 10),
    new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.25 }),
  );
  band2.position.y = -0.6;
  mesh.add(band2);

  // Base glow ring
  const baseRing = new THREE.Mesh(
    new THREE.RingGeometry(r * 0.8, r * 1.3, 12),
    new THREE.MeshBasicMaterial({ color: 0x1e4480, transparent: true, opacity: 0.15, side: THREE.DoubleSide }),
  );
  baseRing.rotation.x = -Math.PI / 2;
  baseRing.position.y = -y + 0.03;
  mesh.add(baseRing);

  wallMeshes.push(mesh);
  // Use the wider BASE radius (r * 1.08) so the collision boundary aligns with
  // the visible tapered base of the cylinder, not the narrower top radius.
  colliders.push({ type: 'circle', x, z, r: r * 1.08 + FP.playerRadius });
  arenaColliders.push({ type: 'circle', x, z, r: r * 1.08 + 0.35 });

  const ob = new YUKA.GameEntity();
  ob.position.set(x, 0.5, z);
  ob.boundingRadius = r + 0.15;
  yukaObs.push(ob);
  entityManager.add(ob);
}

/**
 * Add an elevated platform with ramps for accessibility.
 * Uses yTop so players and bots can walk on it.
 */
function addPlatform(x: number, _y: number, z: number, w: number, h: number, d: number): void {
  const { scene, wallMeshes, colliders, arenaColliders } = gameState;

  // Main platform block
  const platMesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({
      color: 0x142840, roughness: 0.9, metalness: 0.1, emissive: 0x081020, emissiveIntensity: 0.2,
    }),
  );
  platMesh.position.set(x, h / 2, z);
  platMesh.castShadow = true;
  platMesh.receiveShadow = true;
  scene.add(platMesh);
  arenaMeshes.push(platMesh);

  // Platform top edge highlight
  platMesh.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(platMesh.geometry),
      new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.4 }),
    ),
  );
  wallMeshes.push(platMesh);

  // Platform collision with yTop
  colliders.push({ type: 'box', x, z, hw: w * 0.5 + Math.max(FP.playerRadius, 0.2), hd: d * 0.5 + Math.max(FP.playerRadius, 0.2), yTop: h });
  // Arena colliders are slightly larger. Also give them yTop so bots can step on them.
  arenaColliders.push({ type: 'box', x, z, hw: w * 0.5 + 0.45, hd: d * 0.5 + 0.45, yTop: h });

  // Ramp geometry (custom wedge)
  const rampW = 2; // width of the ramp
  const rampL = 3.5; // length of the ramp
  const rampShape = new THREE.Shape();
  rampShape.moveTo(0, 0);
  rampShape.lineTo(rampL, 0);
  rampShape.lineTo(rampL, h);
  rampShape.lineTo(0, 0);
  
  const extrudeSettings = { depth: rampW, bevelEnabled: false };
  const rampGeo = new THREE.ExtrudeGeometry(rampShape, extrudeSettings);
  rampGeo.computeVertexNormals();
  // Center the pivot a bit better
  rampGeo.translate(-rampL / 2, 0, -rampW / 2);

  const rampMat = new THREE.MeshStandardMaterial({
    color: 0x1a3556, roughness: 0.8, metalness: 0.1, emissive: 0x081020, emissiveIntensity: 0.2
  });

  // Decide ramp orientation based on position to face the center of the arena
  const toCenterX = -x;
  const toCenterZ = -z;
  const isXDominant = Math.abs(toCenterX) > Math.abs(toCenterZ);
  
  const rampMesh = new THREE.Mesh(rampGeo, rampMat);
  rampMesh.castShadow = true;
  rampMesh.receiveShadow = true;

  if (isXDominant) {
    const side = Math.sign(toCenterX);
    rampMesh.position.set(x + side * (w / 2 + rampL / 2), 0, z);
    rampMesh.rotation.y = side > 0 ? Math.PI : 0;
    
    // Ramp steps for collision (players/bots slide/step up)
    const steps = 4;
    for (let i = 0; i < steps; i++) {
      const stepH = h * ((i + 1) / steps);
      const stepW = rampL / steps;
      const stepX = x + side * (w / 2 + rampL - stepW * i - stepW / 2);
      colliders.push({ type: 'box', x: stepX, z, hw: stepW * 0.5 + 0.2, hd: rampW * 0.5 + 0.2, yTop: stepH });
      arenaColliders.push({ type: 'box', x: stepX, z, hw: stepW * 0.5 + 0.2, hd: rampW * 0.5 + 0.2, yTop: stepH });
    }
  } else {
    const side = Math.sign(toCenterZ);
    rampMesh.position.set(x, 0, z + side * (d / 2 + rampL / 2));
    rampMesh.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    
    const steps = 4;
    for (let i = 0; i < steps; i++) {
      const stepH = h * ((i + 1) / steps);
      const stepL = rampL / steps;
      const stepZ = z + side * (d / 2 + rampL - stepL * i - stepL / 2);
      colliders.push({ type: 'box', x, z: stepZ, hw: rampW * 0.5 + 0.2, hd: stepL * 0.5 + 0.2, yTop: stepH });
      arenaColliders.push({ type: 'box', x, z: stepZ, hw: rampW * 0.5 + 0.2, hd: stepL * 0.5 + 0.2, yTop: stepH });
    }
  }

  scene.add(rampMesh);
  arenaMeshes.push(rampMesh);
  wallMeshes.push(rampMesh);
}

export function hideArena(): void {
  for (const m of arenaMeshes) m.visible = false;
  for (const p of gameState.pickups) {
    if (p.mesh) p.mesh.visible = false;
    if (p.ring) p.ring.visible = false;
  }
  for (const f of Object.values(gameState.flags)) {
    if (f.mesh) f.mesh.visible = false;
  }
}

export function showArena(): void {
  for (const m of arenaMeshes) m.visible = true;
  for (const p of gameState.pickups) {
    if (p.active && p.mesh) p.mesh.visible = true;
    if (p.active && p.ring) p.ring.visible = true;
  }
  for (const f of Object.values(gameState.flags)) {
    if (f.mesh) f.mesh.visible = true;
  }
}
