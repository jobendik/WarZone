import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { gameState } from '@/core/GameState';
import { getBRMapData } from './BRMap';

export interface Vehicle {
  id: number;
  mesh: THREE.Group;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  yaw: number;
  steerAngle: number;
  speed: number;
  maxSpeed: number;
  health: number;
  maxHealth: number;
  driver: number | null;
  seatsOccupied: number;
  seatCount: number;
}

export const vehicles: Vehicle[] = [];
let _nextVehicleId = 1;

const BASE_URL = import.meta.env.BASE_URL;
const CAR_URLS = [
  `${BASE_URL}models/cars/car1.glb`,
  `${BASE_URL}models/cars/car2.glb`,
];

const gltfLoader = new GLTFLoader();
let _carPrefabsPromise: Promise<THREE.Group[]> | null = null;

function prepRenderable(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if ((mesh as any).isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
}

function fitModelToVehicle(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z, 0.0001);
  const targetMaxDim = 4.4; // roughly matches old procedural car size
  const s = targetMaxDim / maxDim;
  root.scale.multiplyScalar(s);

  root.updateMatrixWorld(true);

  const box2 = new THREE.Box3().setFromObject(root);
  const center2 = new THREE.Vector3();
  box2.getCenter(center2);

  root.position.x -= center2.x;
  root.position.z -= center2.z;
  root.position.y -= box2.min.y;
}

async function loadCarPrefabs(): Promise<THREE.Group[]> {
  if (_carPrefabsPromise) return _carPrefabsPromise;

  _carPrefabsPromise = Promise.all(
    CAR_URLS.map((url) =>
      new Promise<THREE.Group>((resolve, reject) => {
        gltfLoader.load(
          url,
          (gltf) => {
            const root = gltf.scene || gltf.scenes?.[0];
            if (!root) {
              reject(new Error(`No scene in ${url}`));
              return;
            }
            prepRenderable(root);
            fitModelToVehicle(root);
            resolve(root as THREE.Group);
          },
          undefined,
          reject,
        );
      }),
    ),
  ).catch((err) => {
    console.warn('[Vehicles] Failed to load car models. Falling back to box cars.', err);
    return [];
  });

  return _carPrefabsPromise;
}

function buildFallbackVehicleMesh(): THREE.Group {
  const g = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x2c3a4a + Math.floor(Math.random() * 0x202020),
    roughness: 0.4,
    metalness: 0.7,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x223040,
    roughness: 0.05,
    metalness: 0.95,
    emissive: 0x446688,
    emissiveIntensity: 0.15,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0xffaa33,
    emissive: 0xff8800,
    emissiveIntensity: 0.6,
    metalness: 0.8,
    roughness: 0.2,
  });

  const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.6, 4.2), bodyMat);
  body.position.y = 0.75;
  body.castShadow = true;
  g.add(body);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.7, 2.4), bodyMat);
  cabin.position.set(0, 1.3, -0.2);
  cabin.castShadow = true;
  g.add(cabin);

  const wind = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.55, 0.1), glassMat);
  wind.position.set(0, 1.35, 1.1);
  wind.rotation.x = -0.4;
  g.add(wind);

  const rear = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.55, 0.1), glassMat);
  rear.position.set(0, 1.35, -1.5);
  rear.rotation.x = 0.4;
  g.add(rear);

  for (const side of [-1, 1]) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.55, 2.2), glassMat);
    win.position.set(side * 0.92, 1.35, -0.2);
    g.add(win);
  }

  for (const side of [-1, 1]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.2, 0.08), accentMat);
    h.position.set(side * 0.7, 0.75, 2.1);
    g.add(h);

    const light = new THREE.SpotLight(0xffeecc, 3, 25, Math.PI * 0.2, 0.5);
    light.position.set(side * 0.7, 0.8, 2.1);
    light.target.position.set(side * 0.7, 0.4, 12);
    g.add(light);
    g.add(light.target);
  }

  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  for (const xSide of [-1, 1]) {
    for (const zPos of [-1.4, 1.4]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.3, 10), wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(xSide * 1.05, 0.45, zPos);
      g.add(wheel);
    }
  }

  return g;
}

async function attachVehicleModel(root: THREE.Group): Promise<void> {
  const prefabs = await loadCarPrefabs();
  if (!prefabs.length) return;

  const prefab = prefabs[(Math.random() * prefabs.length) | 0];
  const model = prefab.clone(true);

  while (root.children.length) root.remove(root.children[0]);
  root.add(model);
}

export function spawnVehicle(x: number, z: number): Vehicle {
  const g = buildFallbackVehicleMesh();
  g.position.set(x, 0, z);
  gameState.scene.add(g);

  void attachVehicleModel(g);

  const v: Vehicle = {
    id: _nextVehicleId++,
    mesh: g,
    position: new THREE.Vector3(x, 0, z),
    velocity: new THREE.Vector3(),
    yaw: Math.random() * Math.PI * 2,
    steerAngle: 0,
    speed: 0,
    maxSpeed: 26,
    health: 400,
    maxHealth: 400,
    driver: null,
    seatsOccupied: 0,
    seatCount: 4,
  };

  vehicles.push(v);
  return v;
}

export function populateVehicles(): void {
  const map = getBRMapData();
  if (map && map.pois.length > 0) {
    const numCars = Math.min(15, map.pois.length * 2);
    for (let i = 0; i < numCars; i++) {
      const poi = map.pois[i % map.pois.length];
      const angle = Math.random() * Math.PI * 2;
      const dist = poi.radius + 4 + Math.random() * 8;
      spawnVehicle(poi.x + Math.cos(angle) * dist, poi.z + Math.sin(angle) * dist);
    }
  } else {
    // Fallback if no map data
    const spawnPoints: [number, number][] = [
      [-120, -120], [140, -40], [-80, 90], [0, 0], [100, 140],
      [-150, 40], [40, -150], [160, 160], [-180, -180],
      [50, 50], [-50, -50], [180, -100], [-100, 180],
    ];
    for (const [x, z] of spawnPoints) {
      const jitterX = (Math.random() - 0.5) * 8;
      const jitterZ = (Math.random() - 0.5) * 8;
      spawnVehicle(x + jitterX, z + jitterZ);
    }
  }
}

export function findNearbyVehicle(x: number, z: number, range = 3): Vehicle | null {
  let best: Vehicle | null = null;
  let bestDist = range;
  for (const v of vehicles) {
    const dx = v.position.x - x;
    const dz = v.position.z - z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < bestDist) {
      best = v;
      bestDist = d;
    }
  }
  return best;
}

export let playerVehicle: Vehicle | null = null;

export function enterVehicle(v: Vehicle, asDriver: boolean): boolean {
  if (asDriver && v.driver !== null) return false;
  if (asDriver) v.driver = 0;
  v.seatsOccupied++;
  if (asDriver) playerVehicle = v;
  return true;
}

export function exitVehicle(): void {
  if (!playerVehicle) return;
  playerVehicle.driver = null;
  playerVehicle.seatsOccupied = Math.max(0, playerVehicle.seatsOccupied - 1);

  const sideOffset = new THREE.Vector3(
    Math.cos(playerVehicle.yaw + Math.PI / 2) * 2.5,
    0,
    Math.sin(playerVehicle.yaw + Math.PI / 2) * 2.5,
  );

  gameState.player.position.x = playerVehicle.position.x + sideOffset.x;
  gameState.player.position.z = playerVehicle.position.z + sideOffset.z;

  playerVehicle = null;
}

export function updateVehicles(dt: number): void {
  for (const v of vehicles) {
    if (v.driver === 0) {
      const { keys } = gameState;
      const throttle = (keys.w ? 1 : 0) - (keys.s ? 0.6 : 0);
      const steer = (keys.a ? 1 : 0) - (keys.d ? 1 : 0);

      const steerTarget = steer * 0.6;
      v.steerAngle += (steerTarget - v.steerAngle) * dt * 5;

      if (throttle > 0) {
        v.speed += throttle * 18 * dt;
      } else if (throttle < 0) {
        v.speed += throttle * 14 * dt;
      } else {
        v.speed *= Math.max(0, 1 - dt * 0.8);
      }

      v.speed = Math.max(-v.maxSpeed * 0.5, Math.min(v.maxSpeed, v.speed));

      const turnRate = v.steerAngle * (v.speed / v.maxSpeed) * 2.2;
      v.yaw += turnRate * dt;

      v.velocity.x = -Math.sin(v.yaw) * v.speed;
      v.velocity.z = -Math.cos(v.yaw) * v.speed;
      v.position.add(v.velocity.clone().multiplyScalar(dt));

      gameState.player.position.copy(v.position as any);
      gameState.player.position.y = 1.2;

      v.mesh.position.copy(v.position);
      v.mesh.rotation.y = v.yaw;

      for (const c of gameState.colliders) {
        let hit = false;
        if (c.type === 'box') {
          hit = Math.abs(v.position.x - c.x) < c.hw + 1.5 && Math.abs(v.position.z - c.z) < c.hd + 2;
        } else if (c.type === 'circle') {
          const dx = v.position.x - c.x;
          const dz = v.position.z - c.z;
          hit = dx * dx + dz * dz < (c.r + 1.5) * (c.r + 1.5);
        }
        if (hit) {
          v.position.sub(v.velocity.clone().multiplyScalar(dt));
          v.speed *= -0.3;
          break;
        }
      }
    } else {
      v.speed *= Math.max(0, 1 - dt * 2);
      v.position.add(v.velocity.clone().multiplyScalar(dt));
      v.velocity.multiplyScalar(Math.max(0, 1 - dt * 3));
      v.mesh.position.copy(v.position);
      v.mesh.rotation.y = v.yaw;
    }
  }
}

export function damageVehicle(v: Vehicle, dmg: number): void {
  v.health -= dmg;
  if (v.health <= 0) {
    if (playerVehicle === v) exitVehicle();
    gameState.scene.remove(v.mesh);
    const idx = vehicles.indexOf(v);
    if (idx !== -1) vehicles.splice(idx, 1);
  }
}

export function clearVehicles(): void {
  for (const v of vehicles) gameState.scene.remove(v.mesh);
  vehicles.length = 0;
  playerVehicle = null;
}
