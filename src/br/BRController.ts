/**
 * BRController — Match state machine with LOD-aware bot updates.
 *
 * Key behaviours vs previous version:
 *  - buildBRBots is async + chunked, drives a progress bar on the loading screen
 *  - landBRBots() is called exactly when the player jumps from the plane, so
 *    bots start looting at the same moment the player is freefalling (instead
 *    of being frozen up top while the player descends)
 *  - While the player is on the plane, updateBR returns almost immediately;
 *    updateGroundLoot only animates nearby instances
 *  - Bot AI is LOD-gated via shouldUpdateBot
 */
import { resetSupplyDrops, scheduleNextSupplyDrop, updateSupplyDrops } from './SupplyDrops';
import { gameState } from '@/core/GameState';
import { buildBRMap, disposeBRMap } from './BRMap';
import { populateMapLoot, spawnGroundLoot, clearAllLoot, updateGroundLoot, preloadLootVisuals } from './LootSystem';
import { startZone, updateZone, disposeZone } from './ZoneSystem';
import { buildBRBots, clearBRBots, updateBRBot, shouldUpdateBot, landBRBots } from './BRBots';
import { startDropSequence, updateDropSequence, resetDrop, isPlayerInAir, isPlayerOnPlane } from './DropPlane';
import { createEmptyInventory, dumpInventoryOnDeath } from './Inventory';
import { setPlayerInventory, getPlayerInventory } from './InventoryUI';
import { populateVehicles, updateVehicles, clearVehicles } from './Vehicles';
import { updateAI } from '@/ai/AIController';
import { WEAPONS } from '@/config/weapons';
import { hideArena, showArena } from '@/world/Arena';
import { setViewmodelWeapon, setViewmodelVisible } from '@/rendering/WeaponViewmodel';
import type { TDMAgent } from '@/entities/TDMAgent';
import type * as YUKA from 'yuka';

export type BRPhase = 'pregame' | 'airdrop' | 'landing' | 'combat' | 'over';

export interface BRMatchState {
  active: boolean;
  phase: BRPhase;
  phaseStart: number;
  playersAlive: number;
  winnerName: string | null;
  frameCount: number;
}

export const brState: BRMatchState = {
  active: false, phase: 'pregame', phaseStart: 0,
  playersAlive: 30, winnerName: null, frameCount: 0,
};

// ═══════════════════════════════════════════
//  MATCH START / CLEANUP
// ═══════════════════════════════════════════

function nextFrame(): Promise<void> {
  return new Promise(r => requestAnimationFrame(() => r()));
}

function showLoading(msg: string, pct?: number): void {
  let el = document.getElementById('br-loading');
  if (!el) {
    el = document.createElement('div');
    el.id = 'br-loading';
    el.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0a0e18;color:#e0e8f0;font-family:monospace;';
    document.body.appendChild(el);
  }
  const bar = pct != null
    ? `<div style="margin-top:18px;width:320px;height:6px;background:#1a2238;border-radius:3px;overflow:hidden"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#4aa8ff,#60c0ff);transition:width .2s"></div></div>`
    : '';
  el.innerHTML = `<div style="font-size:28px;font-weight:bold;margin-bottom:18px;color:#4aa8ff;">BATTLE ROYALE</div><div style="font-size:16px;opacity:0.8;">${msg}</div>${bar}`;
  el.style.display = 'flex';
}

function hideLoading(): void {
  const el = document.getElementById('br-loading');
  if (el) el.style.display = 'none';
}

let _brStarting = false;

// Previous (TDM) navmesh stashed when BR starts, restored on cleanup so
// returning to an Arena game mode still has working pathfinding.
let _savedNavMesh: YUKA.NavMesh | null = null;
let _savedNavComponents: any[][] | null = null;
let _savedMainComponent: Set<any> | null = null;
let _savedRegionToComponent: Map<any, number> | null = null;
const BR_NAVMESH_URL = `${import.meta.env.BASE_URL}models/br_navmesh.glb`;

export async function startBRMatch(): Promise<void> {
  if (_brStarting) return;
  _brStarting = true;
  try {
  cleanupBR();

  showLoading('Generating map...');
  await nextFrame();

  hideArena();

  // Deactivate arena agents — they stay in the agents array but don't
  // update or render. Their mesh is hidden.
  for (const ag of gameState.agents) {
    if (ag === gameState.player) continue;
    if (!(ag as any)._brState) {
      ag.active = false;
      if (ag.renderComponent) ag.renderComponent.visible = false;
    }
  }

  brState.active = true;
  brState.phase = 'pregame';
  brState.phaseStart = gameState.worldElapsed;
  brState.playersAlive = 30;
  brState.winnerName = null;
  brState.frameCount = 0;

  // Swap in the Battle Royale navmesh. We stash the TDM navmesh (and the
  // derived component metadata) so cleanupBR can restore it when the
  // player returns to an arena mode.
  showLoading('Loading BR navmesh...');
  await nextFrame();
  const nmm = gameState.navMeshManager;
  _savedNavMesh = nmm.navMesh;
  _savedNavComponents = nmm.components;
  _savedMainComponent = nmm.mainComponent;
  _savedRegionToComponent = nmm.regionToComponent;
  try {
    await nmm.load(BR_NAVMESH_URL);
  } catch (err) {
    console.warn('[BR] Failed to load br_navmesh.glb — BR pathfinding will be unavailable.', err);
  }

  await buildBRMap((msg) => showLoading(msg));

  showLoading('Preparing loot visuals...');
  await preloadLootVisuals((done, total) => {
    const pct = (done / total) * 100;
    showLoading(`Preparing loot visuals... (${done}/${total})`, pct);
  });
  await nextFrame();

  showLoading('Spawning loot...');
  await nextFrame();
  populateMapLoot();

  showLoading('Placing vehicles...');
  await nextFrame();
  populateVehicles();
  
  resetSupplyDrops();
  
  // Bot creation is the heaviest step — make it visibly progressive.
  await buildBRBots((done, total) => {
    const pct = (done / total) * 100;
    showLoading(`Assembling combatants... (${done}/${total})`, pct);
  });

  showLoading('Preparing drop...');
  await nextFrame();

  // Player inventory
  const inv = createEmptyInventory();
  inv.ammoLight = 20;
  inv.smallHeals = 1;
  setPlayerInventory(inv);

  // Player state
  gameState.pHP = 100;
  gameState.player.hp = 100;
  gameState.pDead = false;
  gameState.player.isDead = false;

  // IMPORTANT: reset BR spectator and ADS state so nothing leaks from a previous match
  gameState.spectatorTarget = null;
  gameState.isADS = false;

  gameState.pKills = 0;
  gameState.pDeaths = 0;
  gameState.pWeaponSlots = ['knife'];
  gameState.pActiveSlot = 0;
  gameState.pWeaponId = 'knife';
  gameState.pAmmo = 0;
  gameState.pMaxAmmo = 0;
  gameState.pGrenades = 0;
  gameState.pReloading = false;

  setViewmodelWeapon('knife');
  setViewmodelVisible(false);

  startDropSequence();
  brState.phase = 'airdrop';
  brState.phaseStart = gameState.worldElapsed;

  hideLoading();
  } finally { _brStarting = false; }
}

export function cleanupBR(): void {
  brState.active = false;
  disposeZone();
  clearAllLoot();
  clearVehicles();
  resetDrop();
  clearBRBots();
  disposeBRMap();
  resetSupplyDrops();
  showArena();

  // Restore the pre-BR (TDM) navmesh so arena modes still have pathfinding.
  if (_savedNavMesh) {
    const nmm = gameState.navMeshManager;
    nmm.navMesh = _savedNavMesh;
    nmm.components = _savedNavComponents ?? [];
    nmm.mainComponent = _savedMainComponent ?? new Set();
    nmm.regionToComponent = _savedRegionToComponent ?? new Map();
    _savedNavMesh = null;
    _savedNavComponents = null;
    _savedMainComponent = null;
    _savedRegionToComponent = null;
  }

  for (const ag of gameState.agents) {
    if (ag === gameState.player) continue;
    if (!(ag as any)._brState) {
      ag.active = true;
      if (ag.renderComponent) ag.renderComponent.visible = true;
    }
  }
}

function countAlive(): number {
  let c = gameState.pDead ? 0 : 1;
  for (const ag of gameState.agents) {
    if (ag === gameState.player || ag.isDead) continue;
    const brSt = (ag as any)._brState;
    if (!brSt) continue;
    c++;
  }
  return c;
}

// ═══════════════════════════════════════════
//  DEATH DROPS
// ═══════════════════════════════════════════

export function onBRDeath(victim: TDMAgent): void {
  if (victim === gameState.player) {
    const inv = getPlayerInventory();
    if (inv) {
      const items = dumpInventoryOnDeath(inv);
      if (items.length > 0) {
        spawnGroundLoot(victim.position.x, victim.position.z, victim.position.y + 0.4, items, true);
      }
    }
  } else {
    const items: any[] = [];
    if (victim.weaponId !== 'unarmed' && victim.weaponId !== 'knife') {
      const wep = WEAPONS[victim.weaponId];
      items.push({
        id: `w_${victim.weaponId}_c`, category: 'weapon',
        name: wep.name, rarity: 'common', stackSize: 1, qty: 1,
        weaponId: victim.weaponId, damageBonus: 0, spreadReduction: 0,
        magSize: wep.magSize, currentAmmo: victim.ammo, attachments: {},
      });
    }
    if (victim.grenades > 0) {
      items.push({ id: 'gren', category: 'grenade', name: 'Grenade', rarity: 'common', stackSize: 6, qty: victim.grenades });
    }
    if (Math.random() < 0.35) {
      items.push({ id: 'heal_s', category: 'heal', name: 'Bandage', rarity: 'common', stackSize: 10, qty: 2 });
    }
    if (items.length > 0) {
      spawnGroundLoot(victim.position.x, victim.position.z, victim.position.y + 0.4, items, true);
    }
  }
}

// ═══════════════════════════════════════════
//  MAIN BR UPDATE
// ═══════════════════════════════════════════

export function updateBR(dt: number): void {
  if (!brState.active) return;

  brState.frameCount++;

  // Drop plane physics
  if (isPlayerInAir()) {
    updateDropSequence(dt);
  }

  // While the player is on the plane, bots are inactive and the zone
  // hasn't started — nothing to do beyond animating the drop loot.
  if (isPlayerOnPlane()) {
    // Only animate loot every 4th frame during the on-plane window; the
    // player is 120m up and can't see individual boxes.
    if ((brState.frameCount & 3) === 0) updateGroundLoot();
    brState.playersAlive = countAlive();
    return;
  }

  // Transition from 'airdrop' to 'landing' — this is the moment the
  // player jumps. Activate all bots so they start looting.
  if (brState.phase === 'airdrop') {
    brState.phase = 'landing';
    brState.phaseStart = gameState.worldElapsed;
    startZone();
    landBRBots();
  }

  if (!isPlayerInAir()) {
    setViewmodelVisible(true);
  }

  if (brState.phase === 'landing') {
    if (gameState.worldElapsed - brState.phaseStart > 20) {
      brState.phase = 'combat';
      brState.phaseStart = gameState.worldElapsed;
    }
  }

  updateZone(dt);
  updateVehicles(dt);
  updateSupplyDrops(dt);

  // LOD-gated bot updates. `shouldUpdateBot` returns false for inactive
  // bots and applies per-tier frame stagger for distant ones.
  for (const ag of gameState.agents) {
    if (ag === gameState.player || ag.isDead || !ag.active) continue;
    if (!shouldUpdateBot(ag, brState.frameCount)) continue;

    updateAI(ag, dt);

    if ((ag as any)._brState) {
      updateBRBot(ag, dt);
    }
  }

  updateGroundLoot();

  brState.playersAlive = countAlive();

  if (brState.playersAlive <= 1 && brState.phase !== 'over' && brState.phase !== 'pregame') {
    brState.phase = 'over';
    brState.phaseStart = gameState.worldElapsed;
    if (!gameState.pDead) {
      brState.winnerName = 'YOU';
    } else {
      const survivor = gameState.agents.find(a => a !== gameState.player && !a.isDead && (a as any)._brState);
      brState.winnerName = survivor?.name ?? 'UNKNOWN';
    }
  }
}

export function isBRActive(): boolean { return brState.active; }
export function getBRPhase(): BRPhase { return brState.phase; }
