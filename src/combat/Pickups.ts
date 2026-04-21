import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { gameState } from '@/core/GameState';
import { WEAPONS, GRENADE_CONFIG, type WeaponId } from '@/config/weapons';
import { applyWeaponToAgent } from './Combat';
import { setViewmodelWeapon } from '@/rendering/WeaponViewmodel';

const BASE_URL = import.meta.env.BASE_URL;

type PickupType = 'health' | 'ammo' | 'weapon' | 'grenade';
type PickupVisualKey =
  | 'healthkit'
  | 'ammo_crate'
  | 'grenade'
  | 'weapon_crate'
  | 'weapon_smg'
  | 'weapon_ar'
  | 'weapon_shotgun'
  | 'weapon_sniper'
  | 'weapon_launcher';

const MODEL_URLS: Record<PickupVisualKey, string> = {
  healthkit: `${BASE_URL}models/pickups/healthkit.glb`,
  ammo_crate: `${BASE_URL}models/pickups/ammo_crate.glb`,
  grenade: `${BASE_URL}models/pickups/grenade.glb`,
  weapon_crate: `${BASE_URL}models/pickups/weapon_crate.glb`,
  weapon_smg: `${BASE_URL}models/pickups/weapon_smg.glb`,
  weapon_ar: `${BASE_URL}models/pickups/weapon_ar.glb`,
  weapon_shotgun: `${BASE_URL}models/pickups/weapon_shotgun.glb`,
  weapon_sniper: `${BASE_URL}models/pickups/weapon_sniper.glb`,
  weapon_launcher: `${BASE_URL}models/pickups/weapon_launcher.glb`,
};

const TARGET_MAX_DIM: Record<PickupVisualKey, number> = {
  healthkit: 0.62,
  ammo_crate: 0.68,
  grenade: 0.32,
  weapon_crate: 0.72,
  weapon_smg: 0.95,
  weapon_ar: 1.05,
  weapon_shotgun: 1.05,
  weapon_sniper: 1.15,
  weapon_launcher: 1.2,
};

const EXTRA_ROTATION_X: Partial<Record<PickupVisualKey, number>> = {
  weapon_smg: -0.18,
  weapon_ar: -0.16,
  weapon_shotgun: -0.08,
  weapon_sniper: -0.12,
  weapon_launcher: -0.1,
};

const loader = new GLTFLoader();
const prefabCache = new Map<PickupVisualKey, Promise<THREE.Object3D | null>>();

function prepRenderable(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if ((mesh as any).isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((m) => m.clone());
      } else if (mesh.material) {
        mesh.material = mesh.material.clone();
      }
    }
  });
}

function fitModelToOrigin(root: THREE.Object3D, targetMaxDim: number): void {
  root.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z, 0.0001);
  const scale = targetMaxDim / maxDim;
  root.scale.multiplyScalar(scale);

  root.updateMatrixWorld(true);

  const box2 = new THREE.Box3().setFromObject(root);
  const center2 = new THREE.Vector3();
  box2.getCenter(center2);

  root.position.x -= center2.x;
  root.position.z -= center2.z;
  root.position.y -= box2.min.y;
}

function resolveVisualKey(type: PickupType, weaponId?: WeaponId): PickupVisualKey {
  if (type === 'health') return 'healthkit';
  if (type === 'ammo') return 'ammo_crate';
  if (type === 'grenade') return 'grenade';

  switch (weaponId) {
    case 'smg': return 'weapon_smg';
    case 'assault_rifle': return 'weapon_ar';
    case 'shotgun': return 'weapon_shotgun';
    case 'sniper_rifle': return 'weapon_sniper';
    case 'rocket_launcher': return 'weapon_launcher';
    default: return 'weapon_crate';
  }
}

function loadPrefab(key: PickupVisualKey): Promise<THREE.Object3D | null> {
  const cached = prefabCache.get(key);
  if (cached) return cached;

  const promise = new Promise<THREE.Object3D | null>((resolve) => {
    loader.load(
      MODEL_URLS[key],
      (gltf) => {
        const root = (gltf.scene || gltf.scenes?.[0] || null) as THREE.Object3D | null;
        if (!root) {
          resolve(null);
          return;
        }
        prepRenderable(root);
        fitModelToOrigin(root, TARGET_MAX_DIM[key]);
        if (EXTRA_ROTATION_X[key]) root.rotation.x = EXTRA_ROTATION_X[key]!;
        resolve(root);
      },
      undefined,
      () => resolve(null),
    );
  });

  prefabCache.set(key, promise);
  return promise;
}

function createPickupAnchor(x: number, z: number): THREE.Mesh {
  const anchor = new THREE.Mesh(
    new THREE.SphereGeometry(0.001, 3, 2),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 }),
  );
  anchor.position.set(x, 0.5, z);
  anchor.visible = true;
  return anchor;
}

async function attachVisual(anchor: THREE.Mesh, key: PickupVisualKey): Promise<void> {
  const prefab = await loadPrefab(key);
  if (!prefab) return;

  while (anchor.children.length) anchor.remove(anchor.children[0]);

  const obj = prefab.clone(true);
  anchor.add(obj);
}

export function buildPickups(): void {
  const defs: { t: PickupType; col: number; x: number; z: number; weaponId?: WeaponId }[] = [
    { t: 'health', col: 0x22c55e, x: -25, z: 25 },
    { t: 'health', col: 0x22c55e, x: 25, z: -25 },
    { t: 'health', col: 0x22c55e, x: 0, z: 0 },
    { t: 'health', col: 0x22c55e, x: -42, z: 24 },
    { t: 'health', col: 0x22c55e, x: 42, z: -24 },
    { t: 'ammo', col: 0xf59e0b, x: -25, z: -25 },
    { t: 'ammo', col: 0xf59e0b, x: 25, z: 25 },
    { t: 'ammo', col: 0xf59e0b, x: -40, z: 0 },
    { t: 'ammo', col: 0xf59e0b, x: 40, z: 0 },
    { t: 'ammo', col: 0xf59e0b, x: -24, z: -42 },
    { t: 'ammo', col: 0xf59e0b, x: 24, z: 42 },
    { t: 'grenade', col: 0x84cc16, x: -10, z: -18 },
    { t: 'grenade', col: 0x84cc16, x: 10, z: 18 },
    { t: 'grenade', col: 0x84cc16, x: -8, z: 42 },
    { t: 'grenade', col: 0x84cc16, x: 8, z: -42 },
    { t: 'weapon', col: 0x8b5cf6, x: -15, z: 0, weaponId: 'shotgun' },
    { t: 'weapon', col: 0x8b5cf6, x: 15, z: 0, weaponId: 'sniper_rifle' },
    { t: 'weapon', col: 0x8b5cf6, x: 0, z: -30, weaponId: 'rocket_launcher' },
    { t: 'weapon', col: 0x8b5cf6, x: 0, z: 30, weaponId: 'smg' },
  ];

  for (const d of defs) {
    const mesh = createPickupAnchor(d.x, d.z);
    gameState.scene.add(mesh);

    void attachVisual(mesh, resolveVisualKey(d.t, d.weaponId));

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.7, 20),
      new THREE.MeshBasicMaterial({
        color: d.col,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(d.x, 0.04, d.z);
    gameState.scene.add(ring);

    gameState.pickups.push({ mesh, ring, active: true, respawnAt: 0, t: d.t, x: d.x, z: d.z, weaponId: d.weaponId });
  }
}

export function updatePickups(): void {
  const { pickups, worldElapsed, agents, player } = gameState;

  for (const p of pickups) {
    if (!p.active && worldElapsed >= p.respawnAt) {
      p.active = true;
      p.mesh.visible = p.ring.visible = true;
    }

    if (p.active) {
      p.mesh.position.y = 0.5 + Math.sin(worldElapsed * 2 + p.x) * 0.1;
      p.mesh.rotation.y += 0.02;
      (p.ring.material as THREE.MeshBasicMaterial).opacity = 0.25 + Math.sin(worldElapsed * 2.5 + p.z) * 0.1;
      // Emissive glow pulse on pickup mesh
      p.mesh.traverse((child: THREE.Object3D) => {
        if ((child as THREE.Mesh).isMesh) {
          const mat = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
          if (mat.emissive) {
            const pulse = 0.3 + Math.sin(worldElapsed * 3 + p.x * 2) * 0.25;
            mat.emissiveIntensity = pulse;
          }
        }
      });
    }

    // Player proximity pickup
    if (p.active && !player.isDead) {
      const dx = player.position.x - p.x;
      const dz = player.position.z - p.z;
      if (dx * dx + dz * dz < 2.5 * 2.5) {
        if (p.t === 'health' && gameState.pHP < player.maxHP * 0.7) {
          p.active = false;
          p.mesh.visible = p.ring.visible = false;
          p.respawnAt = worldElapsed + 15;
          gameState.pHP = Math.min(100, gameState.pHP + 35);
          player.hp = gameState.pHP;
        } else if (p.t === 'ammo' && gameState.pAmmo < gameState.pMaxAmmo * 0.4) {
          p.active = false;
          p.mesh.visible = p.ring.visible = false;
          p.respawnAt = worldElapsed + 12;
          gameState.pAmmo = gameState.pMaxAmmo;
        } else if (p.t === 'grenade' && gameState.pGrenades < GRENADE_CONFIG.maxGrenades) {
          p.active = false;
          p.mesh.visible = p.ring.visible = false;
          p.respawnAt = worldElapsed + 10;
          gameState.pGrenades = Math.min(GRENADE_CONFIG.maxGrenades, gameState.pGrenades + 1);
        } else if (p.t === 'weapon' && p.weaponId && p.weaponId !== gameState.pWeaponId) {
          const newWep = WEAPONS[p.weaponId];
          const curWep = WEAPONS[gameState.pWeaponId];
          if (newWep.desirability > curWep.desirability || gameState.pAmmo <= 0) {
            p.active = false;
            p.mesh.visible = p.ring.visible = false;
            p.respawnAt = worldElapsed + 25;
            gameState.pWeaponId = p.weaponId;
            gameState.pAmmo = newWep.magSize;
            gameState.pMaxAmmo = newWep.magSize;
            setViewmodelWeapon(p.weaponId);
          }
        }
      }
    }

    for (const ag of agents) {
      if (ag === player || ag.isDead || !p.active) continue;
      const dx = ag.position.x - p.x;
      const dz = ag.position.z - p.z;
      if (dx * dx + dz * dz < 2.5 * 2.5) {
        if (p.t === 'health' && ag.hp < ag.maxHP * 0.7) {
          p.active = false;
          p.mesh.visible = p.ring.visible = false;
          p.respawnAt = worldElapsed + 15;
          ag.hp = Math.min(ag.maxHP, ag.hp + 35);
        } else if (p.t === 'ammo' && ag.weaponId !== 'unarmed' && ag.ammo < ag.magSize * 0.4) {
          p.active = false;
          p.mesh.visible = p.ring.visible = false;
          p.respawnAt = worldElapsed + 12;
          ag.ammo = ag.magSize;
        } else if (p.t === 'grenade' && ag.grenades < GRENADE_CONFIG.maxGrenades) {
          p.active = false;
          p.mesh.visible = p.ring.visible = false;
          p.respawnAt = worldElapsed + 10;
          ag.grenades = Math.min(GRENADE_CONFIG.maxGrenades, ag.grenades + 1);
        } else if (p.t === 'weapon' && p.weaponId) {
          const newWep = WEAPONS[p.weaponId];
          const curWep = WEAPONS[ag.weaponId];
          const shouldPickup = ag.weaponId === 'unarmed' || newWep.desirability > curWep.desirability || ag.ammo <= 0;

          if (shouldPickup) {
            p.active = false;
            p.mesh.visible = p.ring.visible = false;
            p.respawnAt = worldElapsed + 25;
            applyWeaponToAgent(ag, p.weaponId);
          }
        }
      }
    }
  }
}
