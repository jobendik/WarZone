/**
 * FieldUpgradeController — runtime logic for the player's active ability.
 *
 * The field upgrade is bound to a single key (default: Z). It charges over time
 * (and from damage dealt/received, per upgrade), and can be triggered once full.
 * Visual feedback is a HUD icon with circular fill progress.
 *
 * Each upgrade type has its own trigger function. Shared state lives here;
 * per-upgrade side effects call into the relevant game system.
 */

import * as THREE from 'three';
import { gameState } from '@/core/GameState';
import { getActiveLoadout, FIELD_UPGRADES, type FieldUpgradeDef } from '@/config/Loadouts';
import { playHeal, playPickup } from '@/audio/SoundHooks';
import { spawnImpact } from '@/combat/Particles';
import { movement } from '@/movement/MovementController';
import { announce } from '@/ui/Announcer';

interface ControllerState {
  upgradeId: string;
  def: FieldUpgradeDef | null;
  charge: number;       // 0..1
  ready: boolean;
  lastUseTime: number;
  /** Upgrade-specific state bag */
  active: Record<string, any>;
}

const state: ControllerState = {
  upgradeId: '',
  def: null,
  charge: 1,  // start charged on first spawn
  ready: true,
  lastUseTime: -999,
  active: {},
};

let hudEl: HTMLDivElement | null = null;
let hudIconEl: HTMLDivElement | null = null;
let hudNameEl: HTMLDivElement | null = null;
let hudStatusEl: HTMLDivElement | null = null;
let hudFillEl: HTMLDivElement | null = null;

// ═══════════════════════════════════════════
//  INIT / HUD
// ═══════════════════════════════════════════

function ensureHUD(): HTMLDivElement {
  if (hudEl) return hudEl;
  hudEl = document.getElementById('hvFuRow') as HTMLDivElement | null;
  if (!hudEl) {
    hudEl = document.createElement('div');
    hudEl.id = 'hvFuRow';
    hudEl.className = 'hv-fu-row';
    hudEl.innerHTML = `
      <div class="hv-fu-icon" id="hvFuIcon"></div>
      <div class="hv-fu-meta">
        <div class="hv-fu-name" id="hvFuName">FIELD UPGRADE</div>
        <div class="hv-fu-status" id="hvFuStatus">CHARGED · [Z] DEPLOY</div>
      </div>
      <div class="hv-fu-rail" id="hvFuRail"><div class="hv-fu-fill" id="hvFuFill"></div></div>
    `;
    document.body.appendChild(hudEl);
  }
  hudIconEl = document.getElementById('hvFuIcon') as HTMLDivElement | null;
  hudNameEl = document.getElementById('hvFuName') as HTMLDivElement | null;
  hudStatusEl = document.getElementById('hvFuStatus') as HTMLDivElement | null;
  hudFillEl = document.getElementById('hvFuFill') as HTMLDivElement | null;
  return hudEl;
}

function refreshHUDMeta(): void {
  const def = state.def;
  if (!def) return;
  ensureHUD();
  if (hudIconEl) hudIconEl.textContent = def.icon;
  if (hudNameEl) hudNameEl.textContent = def.name.toUpperCase();
}

// ═══════════════════════════════════════════
//  LIFECYCLE
// ═══════════════════════════════════════════

export function initFieldUpgrade(): void {
  ensureHUD();
  syncLoadout();
  bindKey();
}

/** Called on spawn and whenever loadout changes. */
export function syncLoadout(): void {
  const lo = getActiveLoadout();
  const def = FIELD_UPGRADES.find(f => f.id === lo.fieldUpgrade) ?? FIELD_UPGRADES[0];
  state.upgradeId = def.id;
  state.def = def;
  state.charge = 1; // fresh loadout = charged
  state.ready = true;
  refreshHUDMeta();
  updateHUD();
}

function bindKey(): void {
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'z') return;
    if (gameState.paused || gameState.pDead) return;
    tryActivate();
  });
}

// ═══════════════════════════════════════════
//  UPDATE
// ═══════════════════════════════════════════

export function updateFieldUpgrade(dt: number): void {
  const def = state.def;
  if (!def) return;

  // Charge over time
  if (!state.ready) {
    const rate = 1 / def.cooldown;
    state.charge = Math.min(1, state.charge + rate * dt);
    if (state.charge >= 1) {
      state.ready = true;
      announce('FIELD UPGRADE READY', { tier: 'small', color: '#ffcc33', duration: 1.2 });
    }
  }

  // Update active upgrades (stim-in-progress, dead silence timer, etc.)
  if (state.active.deadSilenceTimer > 0) {
    state.active.deadSilenceTimer -= dt;
    if (state.active.deadSilenceTimer <= 0) state.active.deadSilenceActive = false;
  }
  if (state.active.trophySystem) {
    updateTrophySystem(dt);
  }

  updateHUD();
}

function updateHUD(): void {
  ensureHUD();
  if (!hudEl) return;
  hudEl.style.display = '';
  hudEl.classList.toggle('charged', state.ready);
  if (hudStatusEl) {
    hudStatusEl.textContent = state.ready
      ? 'CHARGED · [Z] DEPLOY'
      : `${Math.round(state.charge * 100)}% · CHARGING`;
  }
  if (hudFillEl) {
    hudFillEl.style.width = `${Math.max(0, Math.min(100, state.charge * 100))}%`;
  }
}

/** Award charge on events (damage dealt/taken if the upgrade supports it). */
export function chargeFromEvent(kind: 'damage_dealt' | 'damage_taken' | 'kill', amount: number): void {
  if (state.ready || !state.def) return;
  if (!state.def.chargeOnDamage && kind !== 'kill') return;
  const rate = kind === 'kill' ? 0.15 : amount * 0.004;
  state.charge = Math.min(1, state.charge + rate);
}

// ═══════════════════════════════════════════
//  ACTIVATION
// ═══════════════════════════════════════════

function tryActivate(): void {
  if (!state.ready || !state.def) return;
  state.ready = false;
  state.charge = 0;
  state.lastUseTime = gameState.worldElapsed;

  switch (state.upgradeId) {
    case 'stim': activateStim(); break;
    case 'dead_silence_fu': activateDeadSilence(); break;
    case 'munitions_box': activateMunitionsBox(); break;
    case 'trophy_system': activateTrophySystem(); break;
    case 'dead_mans_hand': /* passive — armed on death, not on press */ break;
    case 'tactical_insertion': activateTacInsertion(); break;
    case 'recon_drone': activateReconDrone(); break;
  }
}

// ═══════════════════════════════════════════
//  PER-UPGRADE IMPLEMENTATIONS
// ═══════════════════════════════════════════

function activateStim(): void {
  const healAmount = Math.min(100 - gameState.pHP, 100);
  gameState.pHP = Math.min(100, gameState.pHP + 80);
  gameState.player.hp = gameState.pHP;
  // Refresh sprint
  movement.tacSprintCooldown = 0;
  movement.tacSprintTimer = 3;
  movement.isTacSprinting = true;
  playHeal();
  spawnImpact(new THREE.Vector3(
    gameState.player.position.x, 1.4, gameState.player.position.z,
  ), 0x22d66a, 12);
  announce('STIMMED', { tier: 'small', color: '#22d66a', duration: 1 });
}

function activateDeadSilence(): void {
  state.active.deadSilenceActive = true;
  state.active.deadSilenceTimer = 10;
  movement.moveSpeedMulOverride = 1.12;
  announce('DEAD SILENCE', { tier: 'small', color: '#a47aff', sub: 'Silent for 10s — refreshes on kill', duration: 1.5 });
}

/** Called from Combat when the player kills someone. Refreshes timer while active. */
export function onPlayerKillForFieldUpgrade(): void {
  if (state.active.deadSilenceActive) {
    state.active.deadSilenceTimer = Math.max(state.active.deadSilenceTimer, 4);
  }
}

export function isDeadSilenceActive(): boolean {
  return !!state.active.deadSilenceActive;
}

function activateMunitionsBox(): void {
  // Spawn a pickup box at player feet
  const p = gameState.player;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.5, 0.4),
    new THREE.MeshStandardMaterial({
      color: 0x556633, emissive: 0x88aa44, emissiveIntensity: 0.4,
    }),
  );
  const fwd = new THREE.Vector3(-Math.sin(gameState.cameraYaw), 0, -Math.cos(gameState.cameraYaw));
  mesh.position.set(p.position.x + fwd.x, 0.25, p.position.z + fwd.z);
  gameState.scene.add(mesh);
  // Hacky: add a light to make it findable
  const light = new THREE.PointLight(0x88aa44, 1.5, 5);
  light.position.copy(mesh.position);
  gameState.scene.add(light);
  announce('AMMO DROP', { tier: 'small', color: '#88aa44', duration: 1 });
  // Cleanup after 40s
  setTimeout(() => {
    gameState.scene.remove(mesh);
    gameState.scene.remove(light);
  }, 40000);
  playPickup();
}

function activateTrophySystem(): void {
  state.active.trophySystem = {
    pos: gameState.player.position.clone(),
    life: 30,
    charges: 2,
    mesh: null as THREE.Mesh | null,
  };
  const trophy = state.active.trophySystem;
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.15, 0.4, 6),
    new THREE.MeshStandardMaterial({
      color: 0x3a6fff, emissive: 0x5588ff, emissiveIntensity: 0.5,
    }),
  );
  mesh.position.set(trophy.pos.x, 0.2, trophy.pos.z);
  gameState.scene.add(mesh);
  trophy.mesh = mesh;
  announce('TROPHY ARMED', { tier: 'small', color: '#3a6fff', duration: 1 });
}

function updateTrophySystem(dt: number): void {
  const t = state.active.trophySystem;
  if (!t || !t.mesh) return;
  t.life -= dt;
  // Rotate
  t.mesh.rotation.y += dt * 2;
  // Destroy incoming explosives in range
  const RANGE = 6;
  for (let i = gameState.bullets.length - 1; i >= 0; i--) {
    const b = gameState.bullets[i];
    if (!b.isRocket && !b.isGrenade) continue;
    if (b.ownerType === 'player') continue;
    const dx = b.mesh.position.x - t.pos.x;
    const dz = b.mesh.position.z - t.pos.z;
    if (dx * dx + dz * dz < RANGE * RANGE) {
      // Neutralize
      spawnImpact(b.mesh.position.clone(), 0xffaa00, 16);
      gameState.scene.remove(b.mesh);
      gameState.bullets.splice(i, 1);
      t.charges--;
      if (t.charges <= 0) t.life = 0;
    }
  }
  if (t.life <= 0) {
    gameState.scene.remove(t.mesh);
    state.active.trophySystem = null;
  }
}

function activateTacInsertion(): void {
  // Mark spawn location at current position
  state.active.tacInsertion = gameState.player.position.clone();
  announce('SPAWN MARKED', { tier: 'small', color: '#ffcc33', duration: 1 });
}

export function getTacInsertionPoint(): THREE.Vector3 | null {
  return state.active.tacInsertion ?? null;
}

export function clearTacInsertion(): void {
  state.active.tacInsertion = null;
}

function activateReconDrone(): void {
  state.active.reconDroneUntil = gameState.worldElapsed + 5;
  announce('RECON DRONE', { tier: 'medium', color: '#00ddff', sub: 'Enemies revealed for 5s', duration: 1.5 });
}

export function isReconDroneActive(): boolean {
  return (state.active.reconDroneUntil ?? 0) > gameState.worldElapsed;
}

/** Call from Combat when player dies, if dead_mans_hand is equipped. */
export function triggerDeadMansHand(pos: THREE.Vector3): void {
  if (state.upgradeId !== 'dead_mans_hand') return;
  // Delayed explosion
  setTimeout(() => {
    // Use existing grenade spawn via import
    import('@/combat/Hitscan').then(m => {
      const down = new THREE.Vector3(0, -0.5, 0).normalize();
      m.spawnGrenade(pos.clone(), down, 'player', gameState.player.team, gameState.player, 0.8, 'frag');
    });
  }, 100);
}