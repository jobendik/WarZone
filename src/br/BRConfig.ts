/**
 * BRConfig — Optimized constants and Fortnite-style palette.
 *
 * Performance budget: target 60fps on mid-range laptop.
 * - Map reduced to 320×320 (still huge, but fewer objects)
 * - 30 bots (from 50) — biggest single perf win
 * - Instanced rendering for repeated geometry
 * - LOD tiers for AI update frequency
 */

import type { WeaponId } from '@/config/weapons';

// ── Map ──
export const BR_MAP_SIZE = 320;
export const BR_MAP_HALF = BR_MAP_SIZE / 2;
export const BR_MAP_MARGIN = BR_MAP_HALF - 3;
export const BR_TOTAL_PLAYERS = 30; // reduced from 50 for performance

// ── AI LOD tiers ──
// Bots beyond TIER2 distance skip most of their update
export const AI_LOD_TIER1 = 50;    // full AI update
export const AI_LOD_TIER2 = 100;   // 1/3 rate AI + simplified shooting
export const AI_LOD_TIER3 = 160;   // 1/6 rate, no particles
export const AI_LOD_CULLED = 220;  // mesh hidden, minimal update

// ── Rarity ──
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export const RARITY_ORDER: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

// Fortnite-style bright rarity colors
export const RARITY_COLORS: Record<Rarity, number> = {
  common: 0xbebebe,
  uncommon: 0x30d158,
  rare: 0x3a9eff,
  epic: 0xc77dff,
  legendary: 0xffc233,
};

export const RARITY_HEX: Record<Rarity, string> = {
  common: '#bebebe',
  uncommon: '#30d158',
  rare: '#3a9eff',
  epic: '#c77dff',
  legendary: '#ffc233',
};

export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 45, uncommon: 28, rare: 15, epic: 8, legendary: 4,
};

export function rollRarity(): Rarity {
  const total = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const rar of RARITY_ORDER) {
    r -= RARITY_WEIGHTS[rar];
    if (r <= 0) return rar;
  }
  return 'common';
}

// ── Weapon rarity pools ──
export const WEAPONS_BY_RARITY: Record<Rarity, WeaponId[]> = {
  common: ['pistol', 'smg'],
  uncommon: ['pistol', 'smg', 'shotgun', 'assault_rifle'],
  rare: ['assault_rifle', 'shotgun', 'sniper_rifle'],
  epic: ['assault_rifle', 'sniper_rifle', 'rocket_launcher'],
  legendary: ['assault_rifle', 'sniper_rifle', 'rocket_launcher'],
};

export interface WeaponRollResult {
  weaponId: WeaponId;
  rarity: Rarity;
  damageBonus: number;
  spreadReduction: number;
}

export function rollWeapon(rarity: Rarity): WeaponRollResult {
  const pool = WEAPONS_BY_RARITY[rarity];
  const weaponId = pool[Math.floor(Math.random() * pool.length)];
  const tier = RARITY_ORDER.indexOf(rarity);
  return { weaponId, rarity, damageBonus: tier * 0.12, spreadReduction: tier * 0.15 };
}

// ── Zone phases ──
export interface ZonePhase {
  waitTime: number;
  shrinkTime: number;
  finalRadius: number;
  damagePerSec: number;
}

export const ZONE_PHASES: ZonePhase[] = [
  { waitTime: 30,  shrinkTime: 60, finalRadius: 120, damagePerSec: 1 },
  { waitTime: 55,  shrinkTime: 45, finalRadius: 65,  damagePerSec: 3 },
  { waitTime: 40,  shrinkTime: 35, finalRadius: 30,  damagePerSec: 6 },
  { waitTime: 30,  shrinkTime: 25, finalRadius: 12,  damagePerSec: 12 },
  { waitTime: 20,  shrinkTime: 15, finalRadius: 0,   damagePerSec: 25 },
];

export const BR_INITIAL_ZONE_RADIUS = BR_MAP_HALF + 20;

// ── Fortnite-style building palette ──
export const BUILDING_PALETTES = [
  { wall: 0x6c8fbf, roof: 0xe8856a, accent: 0xf5c842, trim: 0x3a5a8a },  // blue/orange
  { wall: 0x8ab87c, roof: 0xd4a85a, accent: 0xf0e060, trim: 0x4a6a3a },  // green/gold
  { wall: 0xc49070, roof: 0x7a4a3a, accent: 0xe8d0a0, trim: 0x5a3a2a },  // warm wood
  { wall: 0x9a8ab0, roof: 0x6a5a90, accent: 0xc0a0e0, trim: 0x4a3a6a },  // purple
  { wall: 0xb8b0a0, roof: 0x7a8890, accent: 0xe0dac0, trim: 0x5a6068 },  // stone
  { wall: 0xd0a880, roof: 0xc05050, accent: 0xf0d080, trim: 0x8a5040 },  // terracotta
];

// ── Loot spawn weights ──
export const LOOT_SPAWN_WEIGHTS: Record<string, number> = {
  weapon: 22,
  ammo: 28,
  armor_small: 10,
  armor_big: 3,
  heal_small: 15,
  heal_big: 5,
  shield_small: 8,
  shield_big: 4,
  grenade: 6,
};

// ── Attachment definitions ──
export type AttachmentSlot = 'optic' | 'barrel' | 'mag' | 'grip';
export interface AttachmentDef {
  id: string;
  slot: AttachmentSlot;
  name: string;
  rarity: Rarity;
  spreadMul?: number;
  magMul?: number;
  reloadMul?: number;
}

export const ATTACHMENTS: AttachmentDef[] = [
  { id: 'red_dot', slot: 'optic', name: 'Red Dot', rarity: 'uncommon', spreadMul: 0.85 },
  { id: 'holo', slot: 'optic', name: 'Holographic', rarity: 'rare', spreadMul: 0.75 },
  { id: 'compensator', slot: 'barrel', name: 'Compensator', rarity: 'uncommon', spreadMul: 0.82 },
  { id: 'suppressor', slot: 'barrel', name: 'Suppressor', rarity: 'rare', spreadMul: 0.88 },
  { id: 'ext_mag', slot: 'mag', name: 'Extended Mag', rarity: 'uncommon', magMul: 1.5 },
  { id: 'fast_mag', slot: 'mag', name: 'Fast Mag', rarity: 'rare', reloadMul: 0.7 },
  { id: 'vert_grip', slot: 'grip', name: 'Vertical Grip', rarity: 'uncommon', spreadMul: 0.9 },
  { id: 'angled_grip', slot: 'grip', name: 'Angled Grip', rarity: 'rare', spreadMul: 0.82 },
];
