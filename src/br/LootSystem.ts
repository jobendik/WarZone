import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { gameState } from '@/core/GameState';
import { RARITY_COLORS, rollRarity, rollWeapon, LOOT_SPAWN_WEIGHTS, type Rarity } from './BRConfig';
import { WEAPONS, type WeaponId } from '@/config/weapons';
import { getBRMapData } from './BRMap';
import { SpatialGrid } from './SpatialGrid';
import type { InventoryItem } from './Inventory';
import { getFloorY } from '@/entities/Player';

const BASE_URL = import.meta.env.BASE_URL;

export interface GroundLoot {
  id: number;
  x: number; z: number; y: number;
  items: InventoryItem[];
  rarity: Rarity;
  fromDeath: boolean;
  spawnedAt: number;
  instanceIdx: number;
  alive: boolean;
}

type LootVisualKey =
  | 'ammo_crate'
  | 'grenade'
  | 'bandage'
  | 'healthkit'
  | 'mini_shield'
  | 'shield_potion'
  | 'armor_plate'
  | 'armor_vest'
  | 'weapon_crate'
  | 'weapon_smg'
  | 'weapon_ar'
  | 'weapon_shotgun'
  | 'weapon_sniper'
  | 'weapon_launcher';

interface LootRenderSlot {
  root: THREE.Group;
  lootId: number | null;
  visualKey: LootVisualKey | null;
}

const MODEL_URLS: Record<LootVisualKey, string> = {
  ammo_crate: `${BASE_URL}models/pickups/ammo_crate.glb`,
  grenade: `${BASE_URL}models/pickups/grenade.glb`,
  bandage: `${BASE_URL}models/pickups/bandage.glb`,
  healthkit: `${BASE_URL}models/pickups/healthkit.glb`,
  mini_shield: `${BASE_URL}models/pickups/mini_shield.glb`,
  shield_potion: `${BASE_URL}models/pickups/shield_potion.glb`,
  armor_plate: `${BASE_URL}models/pickups/armor_plate.glb`,
  armor_vest: `${BASE_URL}models/pickups/armor_vest.glb`,
  weapon_crate: `${BASE_URL}models/pickups/weapon_crate.glb`,
  weapon_smg: `${BASE_URL}models/pickups/weapon_smg.glb`,
  weapon_ar: `${BASE_URL}models/pickups/weapon_ar.glb`,
  weapon_shotgun: `${BASE_URL}models/pickups/weapon_shotgun.glb`,
  weapon_sniper: `${BASE_URL}models/pickups/weapon_sniper.glb`,
  weapon_launcher: `${BASE_URL}models/pickups/weapon_launcher.glb`,
};

const MODEL_TARGET_SIZE: Record<LootVisualKey, number> = {
  ammo_crate: 0.78,
  grenade: 0.34,
  bandage: 0.5,
  healthkit: 0.64,
  mini_shield: 0.52,
  shield_potion: 0.72,
  armor_plate: 0.62,
  armor_vest: 0.84,
  weapon_crate: 0.82,
  weapon_smg: 1.0,
  weapon_ar: 1.1,
  weapon_shotgun: 1.08,
  weapon_sniper: 1.18,
  weapon_launcher: 1.24,
};

const MODEL_ROT_X: Partial<Record<LootVisualKey, number>> = {
  weapon_smg: -0.18,
  weapon_ar: -0.16,
  weapon_shotgun: -0.08,
  weapon_sniper: -0.12,
  weapon_launcher: -0.1,
};

const MAX_LOOT = 600;
const MODEL_RADIUS = 34;
const MAX_ACTIVE_MODELS = 36;

export const groundLoot: GroundLoot[] = [];
export const lootGrid = new SpatialGrid<GroundLoot>();

let _nextId = 1;
let beamInstances: THREE.InstancedMesh | null = null;
let _freeInstanceSlots: number[] = [];
const _beamDummy = new THREE.Matrix4().makeScale(0, 0, 0);
const _beamMatrix = new THREE.Matrix4();
const _beamColor = new THREE.Color();

const loader = new GLTFLoader();
const prefabCache = new Map<LootVisualKey, Promise<THREE.Object3D | null>>();
const resolvedPrefabs = new Map<LootVisualKey, THREE.Object3D | null>();

let _preloadPromise: Promise<void> | null = null;
let _visualsReady = false;
let _poolReady = false;

const lootModelLayer = new THREE.Group();
const renderSlots: LootRenderSlot[] = [];
const lootToRenderSlot = new Map<number, number>();

function ensureBeamInstances(): void {
  if (beamInstances) return;

  const beamGeo = new THREE.CylinderGeometry(0.1, 0.5, 14, 6, 1, true);
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });

  beamInstances = new THREE.InstancedMesh(beamGeo, beamMat, MAX_LOOT);
  beamInstances.frustumCulled = false;
  beamInstances.count = MAX_LOOT;

  _freeInstanceSlots = [];
  for (let i = 0; i < MAX_LOOT; i++) {
    beamInstances.setMatrixAt(i, _beamDummy);
    beamInstances.setColorAt(i, new THREE.Color(0));
    _freeInstanceSlots.push(i);
  }

  beamInstances.instanceMatrix.needsUpdate = true;
  if (beamInstances.instanceColor) beamInstances.instanceColor.needsUpdate = true;

  gameState.scene.add(beamInstances);
  if (!lootModelLayer.parent) gameState.scene.add(lootModelLayer);
}

function allocInstanceSlot(): number {
  return _freeInstanceSlots.length > 0 ? _freeInstanceSlots.pop()! : -1;
}

function freeInstanceSlot(idx: number): void {
  if (!beamInstances) return;
  beamInstances.setMatrixAt(idx, _beamDummy);
  beamInstances.instanceMatrix.needsUpdate = true;
  _freeInstanceSlots.push(idx);
}

function rarityWeight(r: Rarity): number {
  return { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 }[r];
}

function topRarity(items: InventoryItem[]): Rarity {
  let top: Rarity = 'common';
  for (const it of items) {
    if (rarityWeight(it.rarity) > rarityWeight(top)) top = it.rarity;
  }
  return top;
}

function prepRenderable(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as any).isMesh) return;

    mesh.castShadow = true;
    mesh.receiveShadow = true;

    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((m) => m.clone());
    } else if (mesh.material) {
      mesh.material = mesh.material.clone();
    }
  });
}

function fitModelToGround(root: THREE.Object3D, targetMaxDim: number): void {
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

function loadPrefab(key: LootVisualKey): Promise<THREE.Object3D | null> {
  const cached = prefabCache.get(key);
  if (cached) return cached;

  const promise = new Promise<THREE.Object3D | null>((resolve) => {
    loader.load(
      MODEL_URLS[key],
      (gltf) => {
        const root = (gltf.scene || gltf.scenes?.[0] || null) as THREE.Object3D | null;
        if (!root) {
          resolvedPrefabs.set(key, null);
          resolve(null);
          return;
        }

        prepRenderable(root);
        fitModelToGround(root, MODEL_TARGET_SIZE[key]);
        if (MODEL_ROT_X[key]) root.rotation.x = MODEL_ROT_X[key]!;
        root.updateMatrixWorld(true);

        resolvedPrefabs.set(key, root);
        resolve(root);
      },
      undefined,
      () => {
        resolvedPrefabs.set(key, null);
        resolve(null);
      },
    );
  });

  prefabCache.set(key, promise);
  return promise;
}

function ensureRenderPool(): void {
  if (_poolReady) return;
  _poolReady = true;

  if (!lootModelLayer.parent) gameState.scene.add(lootModelLayer);

  for (let i = 0; i < MAX_ACTIVE_MODELS; i++) {
    const root = new THREE.Group();
    root.visible = false;
    lootModelLayer.add(root);
    renderSlots.push({ root, lootId: null, visualKey: null });
  }
}

export async function preloadLootVisuals(onProgress?: (done: number, total: number) => void): Promise<void> {
  if (_preloadPromise) return _preloadPromise;

  const keys = Object.keys(MODEL_URLS) as LootVisualKey[];
  _preloadPromise = (async () => {
    ensureBeamInstances();
    ensureRenderPool();

    let done = 0;
    const total = keys.length;

    await Promise.all(
      keys.map(async (key) => {
        await loadPrefab(key);
        done++;
        onProgress?.(done, total);
      }),
    );

    _visualsReady = true;
  })();

  return _preloadPromise;
}

function releaseRenderSlot(slotIndex: number): void {
  const slot = renderSlots[slotIndex];
  if (!slot) return;

  if (slot.lootId !== null) lootToRenderSlot.delete(slot.lootId);
  slot.lootId = null;
  slot.root.visible = false;
}

function applyVisualToSlot(slot: LootRenderSlot, key: LootVisualKey): void {
  if (slot.visualKey === key) return;

  while (slot.root.children.length) {
    const child = slot.root.children[0];
    child.traverse(c => { if ((c as THREE.Mesh).isMesh) { (c as THREE.Mesh).geometry?.dispose(); const mt = (c as THREE.Mesh).material; if (Array.isArray(mt)) mt.forEach(m => m.dispose()); else if (mt) (mt as THREE.Material).dispose(); } });
    slot.root.remove(child);
  }

  const prefab = resolvedPrefabs.get(key) ?? null;
  if (prefab) slot.root.add(prefab.clone(true));
  slot.visualKey = key;
}

function acquireFreeRenderSlot(): number {
  for (let i = 0; i < renderSlots.length; i++) {
    if (renderSlots[i].lootId === null) return i;
  }
  return -1;
}

function resolveWeaponVisual(weaponId?: WeaponId): LootVisualKey {
  switch (weaponId) {
    case 'smg': return 'weapon_smg';
    case 'assault_rifle': return 'weapon_ar';
    case 'shotgun': return 'weapon_shotgun';
    case 'sniper_rifle': return 'weapon_sniper';
    case 'rocket_launcher': return 'weapon_launcher';
    default: return 'weapon_crate';
  }
}

function resolveLootVisual(items: InventoryItem[]): LootVisualKey {
  const weapon = items.find((it) => it.category === 'weapon');
  if (weapon) return resolveWeaponVisual(weapon.weaponId as WeaponId | undefined);
  if (items.some((it) => it.category === 'grenade')) return 'grenade';
  if (items.some((it) => it.id === 'arm_b' || it.id === 'armor_big')) return 'armor_vest';
  if (items.some((it) => it.id === 'arm_s' || it.id === 'armor_small')) return 'armor_plate';
  if (items.some((it) => it.id === 'sh_b' || it.id === 'shield_big')) return 'shield_potion';
  if (items.some((it) => it.id === 'sh_s' || it.id === 'shield_small')) return 'mini_shield';
  if (items.some((it) => it.id === 'heal_b' || it.id === 'heal_big')) return 'healthkit';
  if (items.some((it) => it.id === 'heal_s' || it.id === 'heal_small')) return 'bandage';
  return 'ammo_crate';
}

function syncNearLootModels(): void {
  if (!_poolReady) return;

  const px = gameState.player.position.x;
  const pz = gameState.player.position.z;

  const nearby = lootGrid
    .queryRadius(px, pz, MODEL_RADIUS)
    .filter((entry) => entry.obj.alive)
    .sort((a, b) => a.distSq - b.distSq)
    .slice(0, MAX_ACTIVE_MODELS);

  const desiredIds = new Set<number>();
  for (const entry of nearby) desiredIds.add(entry.obj.id);

  for (let i = 0; i < renderSlots.length; i++) {
    const slot = renderSlots[i];
    if (slot.lootId !== null && !desiredIds.has(slot.lootId)) {
      releaseRenderSlot(i);
    }
  }

  for (const entry of nearby) {
    const g = entry.obj;
    if (lootToRenderSlot.has(g.id)) continue;

    const slotIndex = acquireFreeRenderSlot();
    if (slotIndex < 0) break;

    const slot = renderSlots[slotIndex];
    const key = resolveLootVisual(g.items);
    applyVisualToSlot(slot, key);
    slot.lootId = g.id;
    lootToRenderSlot.set(g.id, slotIndex);
  }

  const t = gameState.worldElapsed;
  for (const entry of nearby) {
    const g = entry.obj;
    const slotIndex = lootToRenderSlot.get(g.id);
    if (slotIndex === undefined) continue;

    const slot = renderSlots[slotIndex];
    const key = resolveLootVisual(g.items);
    if (slot.visualKey !== key) applyVisualToSlot(slot, key);

    const bobY = g.y + Math.sin(t * 2 + g.id) * 0.08;
    const rotY = t * 0.6 + g.id;

    slot.root.visible = true;
    slot.root.position.set(g.x, bobY, g.z);
    slot.root.rotation.set(0, rotY, 0);
  }
}

export function spawnGroundLoot(x: number, z: number, y: number, items: InventoryItem[], fromDeath = false): GroundLoot | null {
  ensureBeamInstances();
  const idx = allocInstanceSlot();
  if (idx < 0) return null;

  const rarity = topRarity(items);
  const loot: GroundLoot = {
    id: _nextId++,
    x,
    z,
    y: Math.max(0.4, y),
    items,
    rarity,
    fromDeath,
    spawnedAt: gameState.worldElapsed,
    instanceIdx: idx,
    alive: true,
  };

  _beamMatrix.makeTranslation(x, loot.y + 7, z);
  beamInstances!.setMatrixAt(idx, _beamMatrix);
  beamInstances!.setColorAt(idx, _beamColor.setHex(RARITY_COLORS[rarity]));
  beamInstances!.instanceMatrix.needsUpdate = true;
  if (beamInstances!.instanceColor) beamInstances!.instanceColor.needsUpdate = true;

  groundLoot.push(loot);
  lootGrid.insert(loot, x, z);
  return loot;
}

export function removeGroundLoot(id: number): void {
  const idx = groundLoot.findIndex((g) => g.id === id);
  if (idx === -1) return;

  const g = groundLoot[idx];
  g.alive = false;

  const slotIndex = lootToRenderSlot.get(g.id);
  if (slotIndex !== undefined) releaseRenderSlot(slotIndex);

  freeInstanceSlot(g.instanceIdx);
  lootGrid.remove(g);
  groundLoot.splice(idx, 1);
}

export function updateGroundLoot(): void {
  if (!beamInstances) return;

  const t = gameState.worldElapsed;
  const px = gameState.player.position.x;
  const pz = gameState.player.position.z;
  let beamDirty = false;

  for (const g of groundLoot) {
    const dx = g.x - px;
    const dz = g.z - pz;
    const d2 = dx * dx + dz * dz;
    if (d2 > 3600) continue;

    const bobY = g.y + Math.sin(t * 2 + g.id) * 0.08;
    _beamMatrix.makeTranslation(g.x, bobY + 7, g.z);
    beamInstances.setMatrixAt(g.instanceIdx, _beamMatrix);
    beamDirty = true;
  }

  if (beamDirty) beamInstances.instanceMatrix.needsUpdate = true;

  // While still high in the air, don't bother showing nearby 3D loot models.
  if (gameState.player.position.y > 12) {
    for (let i = 0; i < renderSlots.length; i++) {
      if (renderSlots[i].lootId !== null) releaseRenderSlot(i);
    }
    return;
  }

  if (_visualsReady && _poolReady) syncNearLootModels();
}

function rollLootItem(): InventoryItem {
  const rarity = rollRarity();
  const total = Object.values(LOOT_SPAWN_WEIGHTS).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const [kind, w] of Object.entries(LOOT_SPAWN_WEIGHTS)) {
    r -= w;
    if (r <= 0) return createItem(kind, rarity);
  }
  return createItem('ammo', rarity);
}

function createItem(kind: string, rarity: Rarity): InventoryItem {
  switch (kind) {
    case 'weapon': {
      const roll = rollWeapon(rarity);
      const wep = WEAPONS[roll.weaponId];
      return {
        id: `w_${roll.weaponId}_${roll.rarity}`,
        category: 'weapon',
        name: wep.name,
        rarity: roll.rarity,
        stackSize: 1,
        qty: 1,
        weaponId: roll.weaponId,
        damageBonus: roll.damageBonus,
        spreadReduction: roll.spreadReduction,
        magSize: wep.magSize,
        currentAmmo: wep.magSize,
        attachments: {},
      };
    }
    case 'ammo': {
      const types: { id: string; name: string; wid: WeaponId; qty: number }[] = [
        { id: 'ammo_light', name: 'Light Ammo', wid: 'smg', qty: 25 + (Math.random() * 25 | 0) },
        { id: 'ammo_med', name: 'Medium Ammo', wid: 'assault_rifle', qty: 20 + (Math.random() * 20 | 0) },
        { id: 'ammo_heavy', name: 'Heavy Ammo', wid: 'sniper_rifle', qty: 6 + (Math.random() * 6 | 0) },
        { id: 'ammo_shell', name: 'Shells', wid: 'shotgun', qty: 6 + (Math.random() * 6 | 0) },
      ];
      const p = types[(Math.random() * types.length) | 0];
      return { id: p.id, category: 'ammo', name: p.name, rarity: 'common', stackSize: 200, qty: p.qty, weaponId: p.wid };
    }
    case 'heal_small':
      return { id: 'heal_s', category: 'heal', name: 'Bandage', rarity: 'common', stackSize: 10, qty: 2 + (Math.random() * 2 | 0) };
    case 'heal_big':
      return { id: 'heal_b', category: 'heal', name: 'Medkit', rarity: 'uncommon', stackSize: 3, qty: 1 };
    case 'shield_small':
      return { id: 'sh_s', category: 'shield', name: 'Mini Shield', rarity: 'common', stackSize: 6, qty: 2 + (Math.random() * 2 | 0) };
    case 'shield_big':
      return { id: 'sh_b', category: 'shield', name: 'Shield Potion', rarity: 'rare', stackSize: 3, qty: 1 };
    case 'armor_small':
      return { id: 'arm_s', category: 'armor', name: 'Light Armor', rarity: 'uncommon', stackSize: 1, qty: 1 };
    case 'armor_big':
      return { id: 'arm_b', category: 'armor', name: 'Heavy Armor', rarity: 'epic', stackSize: 1, qty: 1 };
    case 'grenade':
      return { id: 'gren', category: 'grenade', name: 'Grenade', rarity: 'common', stackSize: 6, qty: 1 + (Math.random() * 2 | 0) };
    default:
      return { id: 'junk', category: 'ammo', name: 'Scrap', rarity: 'common', stackSize: 1, qty: 1 };
  }
}

export function populateMapLoot(): void {
  ensureBeamInstances();
  const map = getBRMapData();
  if (!map) return;

  for (const b of map.buildings) {
    for (const spot of b.lootSpots) {
      if (Math.random() > 0.7) continue;
      const items: InventoryItem[] = [rollLootItem()];
      if (Math.random() < 0.25) items.push(rollLootItem());
      spawnGroundLoot(spot.x, spot.z, spot.y, items);
    }
  }

  for (const poi of map.pois) {
    const n = 2 + (Math.random() * 2 | 0);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * poi.radius;
      const lx = poi.x + Math.cos(a) * r;
      const lz = poi.z + Math.sin(a) * r;
      // Spawn on the navmesh surface. Using a hardcoded 0.4 left every pickup
      // beneath the visible terrain because br_navmesh.glb sits at a non-zero
      // Y (median ≈ 23 m), so the visual ground is ~20 m above world Y=0.
      const ly = getFloorY(lx, lz) + 0.4;
      spawnGroundLoot(lx, lz, ly, [rollLootItem()]);
    }
  }
}

export function clearAllLoot(): void {
  for (const g of groundLoot) {
    const slotIndex = lootToRenderSlot.get(g.id);
    if (slotIndex !== undefined) releaseRenderSlot(slotIndex);
    freeInstanceSlot(g.instanceIdx);
  }

  groundLoot.length = 0;
  lootGrid.clear();

  for (const slot of renderSlots) {
    slot.root.visible = false;
    slot.lootId = null;
  }
  lootToRenderSlot.clear();

  if (beamInstances) {
    beamInstances.geometry.dispose();
    (beamInstances.material as THREE.Material).dispose();
    gameState.scene.remove(beamInstances);
    beamInstances = null;
  }

  _poolReady = false;
  _visualsReady = false;
  _preloadPromise = null;
  _freeInstanceSlots = [];
}
