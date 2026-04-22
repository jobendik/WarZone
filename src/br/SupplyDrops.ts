/**
 * SupplyDrop — Legendary loot crate that falls from the sky mid-match.
 *
 * Every ~90s during the combat phase, a visible beam of light appears
 * somewhere inside the current zone. A crate descends over ~8s with a
 * small parachute, then lands as high-tier loot. Creates a point of
 * interest that pulls bots into conflict — the classic Fortnite loop.
 */

import * as THREE from 'three';
import { gameState } from '@/core/GameState';
import { spawnGroundLoot } from './LootSystem';
import { zone } from './ZoneSystem';
import type { InventoryItem } from './Inventory';
import { WEAPONS } from '@/config/weapons';
import { getFloorY } from '@/entities/Player';

interface ActiveDrop {
  beam: THREE.Mesh;
  crate: THREE.Group;
  targetX: number;
  targetZ: number;
  startY: number;
  landAt: number;
  landed: boolean;
  /** Resolved navmesh-surface Y for the crate once it lands. */
  landY?: number;
}

const active: ActiveDrop[] = [];
let nextDropAt = 0;
const DROP_INTERVAL_MIN = 75;
const DROP_INTERVAL_MAX = 110;
const DESCENT_TIME = 8;

function buildBeam(): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(1.5, 1.5, 140, 12, 1, true);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      varying vec2 vUv; varying float vY;
      void main() { vUv = uv; vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        float fade = smoothstep(1.0, 0.0, vUv.y);
        float pulse = 0.6 + 0.4 * sin(uTime * 3.0 + vUv.y * 8.0);
        vec3 col = vec3(1.0, 0.78, 0.18) * pulse;
        gl_FragColor = vec4(col, fade * 0.75);
      }
    `,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  return new THREE.Mesh(geo, mat);
}

function buildCrate(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 1.2, 1.6),
    new THREE.MeshStandardMaterial({
      color: 0xffb020, roughness: 0.5, metalness: 0.4,
      emissive: 0xff8800, emissiveIntensity: 0.4,
    }),
  );
  body.castShadow = true;
  g.add(body);

  // Gold trim
  const trim = new THREE.Mesh(
    new THREE.BoxGeometry(1.7, 0.08, 1.7),
    new THREE.MeshStandardMaterial({ color: 0xffd060, emissive: 0xffcc33, emissiveIntensity: 0.8, metalness: 0.9 }),
  );
  trim.position.y = 0.62;
  g.add(trim);

  // Chute
  const chute = new THREE.Mesh(
    new THREE.SphereGeometry(1.8, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xffcc33, roughness: 0.6, side: THREE.DoubleSide }),
  );
  chute.position.y = 2.2;
  g.add(chute);

  // Beacon light on top
  const light = new THREE.PointLight(0xffaa33, 4, 30);
  light.position.y = 1.5;
  g.add(light);

  return g;
}

function rollLegendaryLoot(): InventoryItem[] {
  const legendary: InventoryItem[] = [];
  const topWeapons: Array<keyof typeof WEAPONS> = ['assault_rifle', 'sniper_rifle', 'rocket_launcher'];
  const pick = topWeapons[(Math.random() * topWeapons.length) | 0];
  const wep = WEAPONS[pick];
  legendary.push({
    id: `w_${pick}_leg`,
    category: 'weapon',
    name: wep.name,
    rarity: 'legendary',
    stackSize: 1, qty: 1,
    weaponId: pick,
    damageBonus: 0.35,
    spreadReduction: 0.45,
    magSize: wep.magSize,
    currentAmmo: wep.magSize,
    attachments: {},
  });
  legendary.push({ id: 'heal_b', category: 'heal', name: 'Medkit', rarity: 'epic', stackSize: 3, qty: 2 });
  legendary.push({ id: 'sh_b',   category: 'shield', name: 'Shield Potion', rarity: 'rare', stackSize: 3, qty: 2 });
  legendary.push({ id: 'gren',   category: 'grenade', name: 'Grenade', rarity: 'common', stackSize: 6, qty: 3 });
  return legendary;
}

function disposeObj(obj: THREE.Object3D): void {
  obj.traverse(child => {
    if ((child as THREE.Mesh).isMesh) {
      const m = child as THREE.Mesh;
      m.geometry?.dispose();
      if (Array.isArray(m.material)) m.material.forEach(mt => mt.dispose());
      else if (m.material) (m.material as THREE.Material).dispose();
    }
    if ((child as THREE.Light).isLight) (child as THREE.Light).dispose();
  });
}

export function resetSupplyDrops(): void {
  for (const d of active) {
    disposeObj(d.beam); disposeObj(d.crate);
    gameState.scene.remove(d.beam);
    gameState.scene.remove(d.crate);
  }
  active.length = 0;
  nextDropAt = gameState.worldElapsed + 45; // first drop 45s after landing
}

export function scheduleNextSupplyDrop(): void {
  nextDropAt = gameState.worldElapsed + DROP_INTERVAL_MIN + Math.random() * (DROP_INTERVAL_MAX - DROP_INTERVAL_MIN);
}

function spawnOne(): void {
  if (!zone.active) return;
  const r = zone.currentRadius * 0.75;
  const a = Math.random() * Math.PI * 2;
  const tx = zone.currentCenter.x + Math.cos(a) * r * Math.random();
  const tz = zone.currentCenter.y + Math.sin(a) * r * Math.random();
  // Resolve the landing Y now so the descent animation terminates on the
  // actual map surface (br_navmesh sits at a non-zero Y — a hardcoded 0.5
  // would bury the crate tens of metres beneath the terrain).
  const floorY = getFloorY(tx, tz);
  const landY = floorY + 0.5;
  const startY = landY + 140;

  const beam = buildBeam();
  beam.position.set(tx, landY + 70, tz);
  gameState.scene.add(beam);

  const crate = buildCrate();
  crate.position.set(tx, startY, tz);
  gameState.scene.add(crate);

  active.push({
    beam, crate,
    targetX: tx, targetZ: tz,
    startY,
    landY,
    landAt: gameState.worldElapsed + DESCENT_TIME,
    landed: false,
  });
}

export function updateSupplyDrops(dt: number): void {
  const now = gameState.worldElapsed;
  if (now > nextDropAt) {
    spawnOne();
    scheduleNextSupplyDrop();
  }

  for (let i = active.length - 1; i >= 0; i--) {
    const d = active[i];
    const mat = d.beam.material as THREE.ShaderMaterial;
    if (mat.uniforms?.uTime) mat.uniforms.uTime.value = now;

    if (!d.landed) {
      const remaining = d.landAt - now;
      const endY = d.landY ?? 0.5;
      if (remaining <= 0) {
        d.landed = true;
        d.crate.position.y = endY;
        // Drop legendary loot at crate position, just above the floor.
        spawnGroundLoot(d.targetX, d.targetZ, endY - 0.1, rollLegendaryLoot(), false);
        // Beam fades over 6s then removes
      } else {
        const t = 1 - (remaining / DESCENT_TIME);
        const eased = t * t * (3 - 2 * t);
        d.crate.position.y = d.startY - eased * (d.startY - endY);
      }
    } else {
      // Linger 6s after landing, then cleanup
      if (now - d.landAt > 6) {
        disposeObj(d.beam); disposeObj(d.crate);
        gameState.scene.remove(d.beam);
        gameState.scene.remove(d.crate);
        active.splice(i, 1);
      } else {
        // Fade beam
        const fade = 1 - (now - d.landAt) / 6;
        (d.beam.material as THREE.ShaderMaterial).uniforms.uTime.value = now;
        d.beam.scale.y = Math.max(0.01, fade);
      }
    }
  }
}
