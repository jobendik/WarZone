import * as THREE from 'three';
import { gameState } from '@/core/GameState';
import { BR_MAP_HALF } from './BRConfig';
import { getFloorY } from '@/entities/Player';

export type DropState = 'waiting' | 'onPlane' | 'freefall' | 'parachute' | 'landed';

export interface DropContext {
  state: DropState;
  planeStartTime: number;
  planePosition: THREE.Vector3;
  planeDir: THREE.Vector3;
  planeSpeed: number;
  planeMesh: THREE.Group | null;
  playerDropped: boolean;
  parachuteMesh: THREE.Group | null;
  velY: number;
  velXZ: THREE.Vector3;
  enteredStateAt: number;
}

export const drop: DropContext = {
  state: 'waiting',
  planeStartTime: 0,
  planePosition: new THREE.Vector3(),
  planeDir: new THREE.Vector3(),
  planeSpeed: 60,
  planeMesh: null,
  playerDropped: false,
  parachuteMesh: null,
  velY: 0,
  velXZ: new THREE.Vector3(),
  enteredStateAt: 0,
};

function buildPlane(): THREE.Group {
  const g = new THREE.Group();

  const fuselageMat = new THREE.MeshStandardMaterial({ color: 0x7a8a9a, roughness: 0.5, metalness: 0.6 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0xffaa33, roughness: 0.3, metalness: 0.8, emissive: 0xff8800, emissiveIntensity: 0.4 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x222a3a, roughness: 0.15, metalness: 0.9, emissive: 0x3a5a8a, emissiveIntensity: 0.3 });

  const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 18, 10), fuselageMat);
  fuselage.rotation.z = Math.PI / 2;
  g.add(fuselage);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(2.2, 4, 10), fuselageMat);
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 11;
  g.add(nose);

  const tail = new THREE.Mesh(new THREE.ConeGeometry(2.2, 3, 10), fuselageMat);
  tail.rotation.z = Math.PI / 2;
  tail.position.x = -10.5;
  g.add(tail);

  const wing = new THREE.Mesh(new THREE.BoxGeometry(6, 0.5, 22), fuselageMat);
  wing.position.y = 0.5;
  g.add(wing);

  const vStab = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 0.4), fuselageMat);
  vStab.position.set(-9, 2.5, 0);
  g.add(vStab);

  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(1.8, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), glassMat);
  cockpit.position.set(7, 1.5, 0);
  g.add(cockpit);

  for (const side of [-1, 1]) {
    const engine = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 2.5, 8), accentMat);
    engine.rotation.z = Math.PI / 2;
    engine.position.set(2, -0.4, side * 7);
    g.add(engine);

    const propHub = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 8), accentMat);
    propHub.position.set(3.4, -0.4, side * 7);
    g.add(propHub);

    for (let pi = 0; pi < 3; pi++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.6, 0.18), fuselageMat);
      const angle = (pi * Math.PI * 2) / 3;
      blade.position.set(3.4, -0.4 + Math.sin(angle) * 0.8, side * 7 + Math.cos(angle) * 0.8);
      blade.rotation.x = angle;
      g.add(blade);
    }
  }

  // Warning strobes
  for (const side of [-1, 1]) {
    const strobe = new THREE.PointLight(0xff3333, 2, 18);
    strobe.position.set(-2, 0, side * 11);
    g.add(strobe);
    (strobe.userData as any).isStrobe = true;
  }

  return g;
}

function buildParachute(): THREE.Group {
  const g = new THREE.Group();
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(1.6, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x4aa8ff, roughness: 0.6, side: THREE.DoubleSide }),
  );
  canopy.position.y = 1.8;
  g.add(canopy);

  for (let i = 0; i < 4; i++) {
    const stripe = new THREE.Mesh(
      new THREE.SphereGeometry(1.62, 12, 8, (i * Math.PI) / 2 - 0.15, 0.3, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, side: THREE.DoubleSide }),
    );
    stripe.position.y = 1.8;
    g.add(stripe);
  }

  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3;
    const line = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 1.8, 4),
      new THREE.MeshBasicMaterial({ color: 0x888888 }),
    );
    line.position.set(Math.cos(angle) * 1.0, 0.9, Math.sin(angle) * 1.0);
    line.lookAt(0, 1.8, 0);
    line.rotateX(Math.PI / 2);
    g.add(line);
  }

  return g;
}

export function startDropSequence(): void {
  if (!drop.planeMesh) {
    drop.planeMesh = buildPlane();
    gameState.scene.add(drop.planeMesh);
  }
  drop.planeMesh.visible = true;

  const angle = Math.random() * Math.PI * 2;
  const startDist = BR_MAP_HALF + 50;
  drop.planePosition.set(
    Math.cos(angle) * startDist,
    120,
    Math.sin(angle) * startDist,
  );
  drop.planeDir.set(-Math.cos(angle), 0, -Math.sin(angle));
  drop.planeMesh.position.copy(drop.planePosition);
  drop.planeMesh.lookAt(drop.planePosition.clone().add(drop.planeDir));

  drop.state = 'onPlane';
  drop.planeStartTime = gameState.worldElapsed;
  drop.enteredStateAt = gameState.worldElapsed;
  drop.playerDropped = false;

  // Place player at the plane immediately
  gameState.player.position.set(drop.planePosition.x, drop.planePosition.y - 2, drop.planePosition.z);
}

export function playerJumpFromPlane(): void {
  if (drop.state !== 'onPlane') return;
  drop.state = 'freefall';
  drop.enteredStateAt = gameState.worldElapsed;
  drop.velY = -5;
  drop.velXZ.copy(drop.planeDir).multiplyScalar(drop.planeSpeed * 0.5);
  gameState.player.position.set(drop.planePosition.x, drop.planePosition.y - 2, drop.planePosition.z);
  drop.playerDropped = true;
}

export function deployParachute(): void {
  if (drop.state !== 'freefall') return;
  drop.state = 'parachute';
  drop.enteredStateAt = gameState.worldElapsed;
  drop.velY = -8;
  if (!drop.parachuteMesh) drop.parachuteMesh = buildParachute();
  gameState.scene.add(drop.parachuteMesh);
  drop.parachuteMesh.visible = true;
}

export function updateDropSequence(dt: number): void {
  if (drop.state === 'waiting' || drop.state === 'landed') return;

  if (drop.state === 'onPlane' && drop.planeMesh) {
    drop.planePosition.add(drop.planeDir.clone().multiplyScalar(drop.planeSpeed * dt));
    drop.planeMesh.position.copy(drop.planePosition);
    drop.planeMesh.lookAt(drop.planePosition.clone().add(drop.planeDir));

    // Player rides the plane
    gameState.player.position.set(drop.planePosition.x, drop.planePosition.y - 2, drop.planePosition.z);

    drop.planeMesh.traverse((obj) => {
      if ((obj as any).isPointLight && (obj.userData as any).isStrobe) {
        (obj as THREE.PointLight).intensity = Math.random() > 0.5 ? 2.5 : 0.5;
      }
    });

    const elapsed = gameState.worldElapsed - drop.planeStartTime;
    if (elapsed > 20 && !drop.playerDropped) {
      playerJumpFromPlane();
    }

    if (elapsed > 30) {
      if (drop.planeMesh) drop.planeMesh.visible = false;
    }
    return;
  }

  if (drop.state === 'freefall') {
    drop.velY -= 18 * dt;
    drop.velY = Math.max(drop.velY, -55);
    applyAirControl(dt, 40);

    gameState.player.position.y += drop.velY * dt;
    gameState.player.position.x += drop.velXZ.x * dt;
    gameState.player.position.z += drop.velXZ.z * dt;

    if (gameState.player.position.y < 35) {
      deployParachute();
    }
    return;
  }

  if (drop.state === 'parachute') {
    drop.velY = Math.max(-9, drop.velY - 6 * dt);
    drop.velY = THREE_lerp(drop.velY, -9, dt * 2);
    applyAirControl(dt, 18);
    drop.velXZ.multiplyScalar(Math.max(0, 1 - dt * 0.8));

    gameState.player.position.y += drop.velY * dt;
    gameState.player.position.x += drop.velXZ.x * dt;
    gameState.player.position.z += drop.velXZ.z * dt;

    if (drop.parachuteMesh) {
      drop.parachuteMesh.position.copy(gameState.player.position as any);
    }

    // Detect landing against the actual floor, not a hardcoded y=0. br_navmesh
    // sits at a variable non-zero Y, so a fixed `<= 0.1` threshold makes the
    // player fall straight through the visible terrain before the landing
    // code ever runs. Sampling `getFloorY` here means the trigger fires the
    // moment the parachuting player intersects the navmesh surface.
    const floorY = getFloorY(gameState.player.position.x, gameState.player.position.z);
    if (gameState.player.position.y <= floorY + 0.1) {
      // Snap to the navmesh surface instead of hardcoding y=0. The glb map's
      // floor sits at whatever Y `br_navmesh.glb` defines; forcing y=0 here
      // used to leave the player on a different plane than the AI (who
      // track the navmesh) and, when the navmesh Y exceeded
      // NAV_COLLIDE_Y_EPSILON, the player became unable to move because
      // `collidesPlayer` could no longer locate a walkable region.
      gameState.player.position.y = floorY;
      gameState.pPosY = floorY;
      gameState.pVelY = 0;
      drop.state = 'landed';
      if (drop.parachuteMesh) drop.parachuteMesh.visible = false;
    }
    return;
  }
}

function applyAirControl(dt: number, accel: number): void {
  const { keys, cameraYaw } = gameState;
  const forward = (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
  const strafe = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
  if (!forward && !strafe) return;
  const fx = -Math.sin(cameraYaw);
  const fz = -Math.cos(cameraYaw);
  const sx = Math.cos(cameraYaw);
  const sz = -Math.sin(cameraYaw);
  drop.velXZ.x += (fx * forward + sx * strafe) * accel * dt;
  drop.velXZ.z += (fz * forward + sz * strafe) * accel * dt;
  const maxH = 30;
  const hSpd = Math.hypot(drop.velXZ.x, drop.velXZ.z);
  if (hSpd > maxH) drop.velXZ.multiplyScalar(maxH / hSpd);
}

function THREE_lerp(a: number, b: number, t: number): number { return a + (b - a) * Math.min(1, t); }

export function isPlayerDropping(): boolean {
  return drop.state !== 'landed' && drop.state !== 'waiting';
}

export function isPlayerInAir(): boolean {
  return drop.state === 'onPlane' || drop.state === 'freefall' || drop.state === 'parachute';
}

export function isPlayerOnPlane(): boolean {
  return drop.state === 'onPlane';
}

function disposeMeshTree(obj: THREE.Object3D): void {
  obj.traverse(child => {
    if ((child as THREE.Mesh).isMesh) {
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
      if (Array.isArray(m.material)) m.material.forEach(mt => mt.dispose());
      else if (m.material) (m.material as THREE.Material).dispose();
    }
  });
}

export function resetDrop(): void {
  if (drop.planeMesh) { disposeMeshTree(drop.planeMesh); gameState.scene.remove(drop.planeMesh); }
  if (drop.parachuteMesh) { disposeMeshTree(drop.parachuteMesh); gameState.scene.remove(drop.parachuteMesh); }
  drop.planeMesh = null;
  drop.parachuteMesh = null;
  drop.state = 'waiting';
  drop.playerDropped = false;
}
