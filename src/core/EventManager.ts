import * as THREE from 'three';
import { gameState } from './GameState';
import { FP } from '@/config/player';
import { dom } from '@/ui/DOMElements';
import { getStreakFireRateMult } from '@/combat/Streaks';
import { WEAPONS, GRENADE_CONFIG } from '@/config/weapons';
import { hitscanShot, shotgunBlast, spawnRocket, spawnGrenade } from '@/combat/Hitscan';
import { updateHUD, flashCrosshairFire } from '@/ui/HUD';
import { fireViewmodel, setViewmodelWeapon, resizeViewmodel } from '@/rendering/WeaponViewmodel';
import { togglePause, syncLockHintVisibility } from '@/ui/Menus';
import { skipIntro } from '@/ui/MatchIntro';
import { isPlayerInAir, drop, playerJumpFromPlane, deployParachute } from '@/br/DropPlane';
import { getPlayerInventory, setBRActiveSlotByOrder, syncInventoryFromCombat, toggleInventory, pickupNearestLoot, isInventoryOpen, closeInventory } from '@/br/InventoryUI';
import { getAmmoPool, getAttachmentModifiers } from '@/br/Inventory';
import { requestJump, toggleCrouch, setLean, attemptSlide, movement } from '@/movement/MovementController';
import { Audio } from '@/audio/AudioManager';
import { playEmptyClick, playWeaponSwap, playReload } from '@/audio/SoundHooks';
import { applyPlayerRecoil } from '@/combat/Recoil';
import { getSuppressionSpreadMul } from '@/combat/Suppression';
import { shakeOnShot } from '@/movement/CameraShake';
import { startBRMatch } from '@/br/BRController';
import { playerVehicle, exitVehicle, findNearbyVehicle, enterVehicle } from '@/br/Vehicles';
import { fireDeferredPing } from '@/ui/PingSystem';
import { beginADS, endADS, adsAccuracyMul } from '@/combat/EnhancedADS';
import { getActivePerkHooks } from '@/config/Loadouts';
import { isInTrainingRange, recordShotFired } from '@/combat/TrainingRange';

let lastShiftPressTime = 0;

// ── Keybind remapping system ──
export type ActionKey = 'forward' | 'left' | 'back' | 'right' | 'reload' | 'sprint'
  | 'grenade' | 'weapon1' | 'weapon2' | 'weapon3' | 'lastWeapon' | 'jump'
  | 'crouch' | 'leanLeft' | 'leanRight' | 'ping' | 'interact' | 'melee' | 'cycleGrenade';

const defaultKeyMap: Record<ActionKey, string> = {
  forward: 'w', left: 'a', back: 's', right: 'd',
  reload: 'r', sprint: 'shift', grenade: 'g',
  weapon1: '1', weapon2: '2', weapon3: '3', lastWeapon: 'v',
  jump: ' ', crouch: 'c', leanLeft: 'q', leanRight: 'e',
  ping: 'x', interact: 'f', melee: 'v', cycleGrenade: '4',
};

let keyMap: Record<ActionKey, string> = { ...defaultKeyMap };

/** Get the current key mapping */
function getKeyMap(): Record<ActionKey, string> { return { ...keyMap }; }

/** Set a keybind */
function setKeybind(action: ActionKey, key: string): void {
  keyMap[action] = key.toLowerCase();
  try { localStorage.setItem('warzone_keybinds', JSON.stringify(keyMap)); } catch { /* ignore */ }
}

/** Load keybinds from localStorage */
function loadKeybinds(): void {
  try {
    const raw = localStorage.getItem('warzone_keybinds');
    if (raw) keyMap = { ...defaultKeyMap, ...JSON.parse(raw) };
  } catch { /* ignore */ }
}

/** Check if a pressed key matches an action */
function isAction(key: string, action: ActionKey): boolean {
  return key === keyMap[action];
}

const _fwd = new THREE.Vector3();
function getCameraForward(): THREE.Vector3 {
  const { cameraYaw, cameraPitch } = gameState;
  return _fwd.set(
    -Math.sin(cameraYaw) * Math.cos(cameraPitch),
    Math.sin(cameraPitch),
    -Math.cos(cameraYaw) * Math.cos(cameraPitch),
  ).normalize();
}

function getAimPoint(fwd: THREE.Vector3, maxDist = 160): THREE.Vector3 {
  const origin = gameState.camera.position.clone();
  const rc = gameState.raycaster;
  rc.set(origin, fwd);
  rc.near = 0;
  rc.far = maxDist;
  const wallHits = rc.intersectObjects(gameState.wallMeshes, false);
  return wallHits.length > 0
    ? wallHits[0].point.clone()
    : origin.add(fwd.clone().multiplyScalar(maxDist));
}

function getShotOrigin(kind: 'hitscan' | 'projectile' | 'grenade'): THREE.Vector3 {
  const fwd = getCameraForward();
  const origin = gameState.camera.position.clone();
  if (kind === 'projectile') return origin.add(fwd.multiplyScalar(0.9)).add(new THREE.Vector3(0, -0.05, 0));
  if (kind === 'grenade') return origin.add(fwd.multiplyScalar(0.45)).add(new THREE.Vector3(0, -0.08, 0));
  return origin.add(fwd.multiplyScalar(0.15));
}

function updateBRAmmoAfterShot(): void {
  if (gameState.mode !== 'br') return;
  syncInventoryFromCombat();
}

function finishReloadForBR(): boolean {
  if (gameState.mode !== 'br') return false;
  const inv = getPlayerInventory();
  if (!inv) return false;
  const activeItem = inv.weaponSlots[inv.activeSlot];
  if (!activeItem || activeItem.category !== 'weapon' || !activeItem.weaponId) return false;

  return gameState.pAmmo < gameState.pMaxAmmo && getAmmoPool(inv, activeItem.weaponId) > 0;
}

function startReload(): void {
  if (gameState.pWeaponId === 'unarmed' || gameState.pWeaponId === 'knife') return;
  if (gameState.mode === 'br' && !finishReloadForBR()) return;
  const wep = WEAPONS[gameState.pWeaponId];
  gameState.pReloading = true;
  gameState.pReloadTimer = 0;
  // Tactical reload (mag not empty) is 25% faster than empty reload
  const tacMul = gameState.pAmmo > 0 ? 0.75 : 1.0;
  let reloadMul = getActivePerkHooks().reloadMul ?? 1;
  if (gameState.mode === 'br') {
    const inv = getPlayerInventory();
    if (inv) reloadMul *= getAttachmentModifiers(inv).reloadMul;
  }
  gameState.pReloadDuration = wep.reloadTime * tacMul * reloadMul;
  dom.reloadBar.classList.add('on');
  dom.reloadText.classList.add('on');
  playReload(gameState.pAmmo > 0, true, undefined, gameState.pWeaponId);
}

function switchWeapon(slot: number): void {
  if (slot >= gameState.pWeaponSlots.length) return;
  if (gameState.pActiveSlot === slot) return;
  if (gameState.pReloading) {
    gameState.pReloading = false;
    dom.reloadBar.classList.remove('on');
    dom.reloadText.classList.remove('on');
  }

  const prevSlot = gameState.pActiveSlot;

  if (gameState.mode === 'br') {
    if (!setBRActiveSlotByOrder(slot)) return;
    gameState.pLastSlot = prevSlot;
    gameState.pShootTimer = 0;
    gameState.pBurstCount = 0;
    playWeaponSwap();
    return;
  }

  gameState.pLastSlot = prevSlot;
  gameState.pActiveSlot = slot;
  gameState.pWeaponId = gameState.pWeaponSlots[slot];

  const wep = WEAPONS[gameState.pWeaponId];
  gameState.pAmmo = wep.magSize;
  gameState.pMaxAmmo = wep.magSize;
  gameState.pShootTimer = 0;
  gameState.pBurstCount = 0;
  gameState.pFirstShotReady = true;
  gameState.pSpreadAccum = 0;
  playWeaponSwap();

  setViewmodelWeapon(gameState.pWeaponId, true);
  updateHUD();
}

export function onShoot(): void {
  if (gameState.pDead || gameState.pReloading) return;
  if (gameState.pWeaponId === 'unarmed') return; // can't shoot unarmed
  if (gameState.pShootTimer > 0) return;
  if (isPlayerInAir()) return; // no shooting during BR drop
  // Firing forcefully and instantly cancels sprinting so the shot is never eaten.
  if (movement.isSprinting || movement.isTacSprinting || movement.sprintT > 0) {
    movement.isSprinting = false;
    movement.isTacSprinting = false;
    movement.sprintT = 0; // eliminate sprint-to-fire delay for responsiveness
  }

  const { player, pWeaponId } = gameState;
  const wep = WEAPONS[pWeaponId];
  const fwd = getCameraForward();

  // Knife melee attack — no ammo needed
  if (pWeaponId === 'knife') {
    const o = new THREE.Vector3(player.position.x, player.position.y + FP.height - 0.2, player.position.z);
    hitscanShot(o, fwd, 'player', player.team, pWeaponId, 0x60a5fa, player);
    fireViewmodel();
    gameState.pShootTimer = wep.fireRate;
    // Melee lunge — forward velocity burst
    const lungeSpeed = 8;
    movement.velocity.x += fwd.x * lungeSpeed;
    movement.velocity.z += fwd.z * lungeSpeed;
    updateHUD();
    return;
  }

  if (gameState.pAmmo <= 0) {
    playEmptyClick();
    startReload();
    return;
  }

  const aimPoint = getAimPoint(fwd, Math.max(wep.range, 120));
  const originKind = pWeaponId === 'rocket_launcher' ? 'projectile' : 'hitscan';
  const o = getShotOrigin(originKind);
  const dir = aimPoint.clone().sub(o).normalize();
  // Training range shot tracking
  if (isInTrainingRange()) recordShotFired();
  const errMul = gameState.isADS ? adsAccuracyMul() : gameState.keys.shift ? 1.35 : 1.0;
  const firstShotBonus = (gameState.pAmmo === gameState.pMaxAmmo || gameState.pFirstShotReady) ? 0.5 : 1;
  const spreadAccum = gameState.pSpreadAccum;
  const suppressMul = getSuppressionSpreadMul();
  // BR attachment spread bonus
  let attachMul = 1;
  if (gameState.mode === 'br') {
    const inv = getPlayerInventory();
    if (inv) attachMul = getAttachmentModifiers(inv).spreadMul;
  }
  const err = wep.aimError * errMul * firstShotBonus * suppressMul * attachMul + spreadAccum * 0.012;
  if (err > 0) {
    dir.x += (Math.random() - 0.5) * err;
    dir.y += (Math.random() - 0.5) * err * 0.5;
    dir.z += (Math.random() - 0.5) * err;
    dir.normalize();
  }
  // Accumulate spread from sustained fire (decays in updatePlayer)
  gameState.pSpreadAccum = Math.min(8, gameState.pSpreadAccum + 1);

  if (pWeaponId === 'rocket_launcher') {
    spawnRocket(o, dir, 'player', player.team, 0x60a5fa, player);
  } else if (pWeaponId === 'shotgun') {
    shotgunBlast(o, dir, 'player', player.team, 0x60a5fa, player);
  } else {
    hitscanShot(o, dir, 'player', player.team, pWeaponId, 0x60a5fa, player);
  }

  applyPlayerRecoil(pWeaponId);

  fireViewmodel();
  flashCrosshairFire();
  shakeOnShot(wep.damage / 100);
  gameState.pAmmo--;
  gameState.pShotsFired++;
  updateBRAmmoAfterShot();
  gameState.pShootTimer = wep.fireRate * getStreakFireRateMult();
  gameState.pFirstShotReady = false;
  updateHUD();

  if (gameState.pAmmo <= 0) startReload();
}

function startCookGrenade(): void {
  if (gameState.pDead) return;
  const gType = gameState.pGrenadeType;
  const available = gType === 'smoke' ? gameState.pSmokes : gType === 'flash' ? gameState.pFlashbangs : gameState.pGrenades;
  if (available <= 0) return;
  if (gameState.pGrenadeCooldown > 0) return;
  if (gameState.pCookingGrenade) return;
  if (isPlayerInAir()) return;

  gameState.pCookingGrenade = true;
  gameState.pCookTimer = 0;
}

export function releaseGrenade(): void {
  if (!gameState.pCookingGrenade) return;
  gameState.pCookingGrenade = false;

  const { player } = gameState;
  const dir = getCameraForward();
  const o = getShotOrigin('grenade');
  const life = Math.max(0.3, 2.5 - gameState.pCookTimer);
  const gType = gameState.pGrenadeType;

  spawnGrenade(o, dir, 'player', player.team, player, life, gType);
  if (gType === 'smoke') gameState.pSmokes--;
  else if (gType === 'flash') gameState.pFlashbangs--;
  else gameState.pGrenades--;
  syncInventoryFromCombat();
  gameState.pGrenadeCooldown = GRENADE_CONFIG.cooldown;
  gameState.pCookTimer = 0;
  updateHUD();
}

function requestMouseLock(): void {
  Audio.resume();
  gameState.renderer?.domElement?.requestPointerLock();
}

function onPointerLockChange(): void {
  const wasLocked = gameState.mouseLocked;
  gameState.mouseLocked = document.pointerLockElement === gameState.renderer.domElement;
  if (
    wasLocked
    && !gameState.mouseLocked
    && !gameState.paused
    && !gameState.mainMenuOpen
    && !gameState.roundOver
    && !gameState._introActive
    && !gameState.commWheelOpen
    && !isInventoryOpen()
  ) {
    togglePause(true);
    return;
  }
  if (!gameState.mouseLocked) gameState.isADS = false;
  syncLockHintVisibility();
}

function onMouseMove(e: MouseEvent): void {
  if (!gameState.mouseLocked || gameState.pDead) return;
  gameState.cameraYaw -= e.movementX * FP.sensitivity;
  gameState.cameraPitch -= e.movementY * FP.sensitivity;
  gameState.cameraPitch = Math.max(FP.pitchMin, Math.min(FP.pitchMax, gameState.cameraPitch));
  gameState.mouseDeltaX += e.movementX;
  gameState.mouseDeltaY += e.movementY;
}

let _eventsBound = false;

export function bindEvents(): void {
  if (_eventsBound) return; // Prevent duplicate listener stacking on hot reload
  _eventsBound = true;

  const { keys } = gameState;
  loadKeybinds();

  window.addEventListener('keydown', async (e) => {
    const k = e.key.toLowerCase();
    // Map remappable keys to the key state object
    if (isAction(k, 'forward'))  { keys.w = true; e.preventDefault(); }
    if (isAction(k, 'left'))     { keys.a = true; e.preventDefault(); }
    if (isAction(k, 'back'))     { keys.s = true; e.preventDefault(); }
    if (isAction(k, 'right'))    { keys.d = true; e.preventDefault(); }
    if (isAction(k, 'reload'))   { keys.r = true; e.preventDefault(); }
    if (isAction(k, 'sprint'))   { keys.shift = true; e.preventDefault(); }
    if (isAction(k, 'grenade'))  { keys.g = true; e.preventDefault(); }
    if (isAction(k, 'weapon1'))  { keys['1'] = true; e.preventDefault(); }
    if (isAction(k, 'weapon2'))  { keys['2'] = true; e.preventDefault(); }
    if (isAction(k, 'weapon3'))  { keys['3'] = true; e.preventDefault(); }
    if (k === 'tab') { e.preventDefault(); keys.tab = true; }

    if (isAction(k, 'reload') && !gameState.pDead && !gameState.pReloading && gameState.pWeaponId !== 'unarmed' && gameState.pAmmo < gameState.pMaxAmmo && (gameState.mode === 'br' || gameState.pAmmoReserve > 0)) {
      startReload();
    }

    if (isAction(k, 'grenade')) startCookGrenade();

    if (k === 'enter' && gameState.mode === 'br' && gameState.pDead) {
      await startBRMatch();
      return;
    }

    if (isAction(k, 'weapon1')) switchWeapon(0);
    if (isAction(k, 'weapon2')) switchWeapon(1);
    if (isAction(k, 'weapon3')) switchWeapon(2);
    if (isAction(k, 'lastWeapon')) switchWeapon(gameState.pLastSlot);

    // BR keys
    if (gameState.mode === 'br') {
      if (k === 'i') {
        toggleInventory();
        e.preventDefault();
        return;
      }
      if (isAction(k, 'interact')) {
        pickupNearestLoot();
      }
      if (k === ' ') {
        if (drop.state === 'onPlane') { playerJumpFromPlane(); return; }
        if (drop.state === 'freefall') { deployParachute(); return; }
      }
      if (k === 'f') {
        if (playerVehicle) {
          exitVehicle();
        } else {
          const near = findNearbyVehicle(gameState.player.position.x, gameState.player.position.z, 3);
          if (near) enterVehicle(near, true);
        }
      }
    }

    // Movement keys
    if (isAction(k, 'jump') && !gameState.pDead) {
      requestJump();
    }
    if (isAction(k, 'crouch')) {
      toggleCrouch();
      if (keys.shift && (keys.w || keys.a || keys.s || keys.d)) attemptSlide();
    }
    if (isAction(k, 'leanLeft')) setLean(-1);
    if (isAction(k, 'leanRight')) setLean(1);
    if (isAction(k, 'sprint') && (keys.w || keys.a || keys.s || keys.d)) {
      // First press of shift while moving — try slide if already at speed
      // (real slide is auto when sprint+crouch, but C+Shift triggers it)
      attemptSlide();
      // Double-tap shift → tactical sprint
      const now = performance.now();
      if (now - lastShiftPressTime < 350 && movement.tacSprintCooldown <= 0 && !movement.isTacSprinting) {
        movement.isTacSprinting = true;
        movement.tacSprintTimer = 3;
      }
      lastShiftPressTime = now;
    }
    if (isAction(k, 'ping')) {
      fireDeferredPing();
    }

    if (isAction(k, 'cycleGrenade')) {
      const seq: ('frag' | 'smoke' | 'flash')[] = ['frag', 'smoke', 'flash'];
      const idx = seq.indexOf(gameState.pGrenadeType);
      gameState.pGrenadeType = seq[(idx + 1) % seq.length];
      updateHUD();
    }

    if (k === 'escape') {
      e.preventDefault();
      if (gameState._introActive) {
        gameState._pauseOnIntroEnd = true;
        skipIntro();
        return;
      }
      if (gameState.mode === 'br') {
        if (isInventoryOpen()) { closeInventory(); return; }
      }
      togglePause();
      return;
    }
  });

  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    // Reverse-map keys
    if (isAction(k, 'forward'))  keys.w = false;
    if (isAction(k, 'left'))     keys.a = false;
    if (isAction(k, 'back'))     keys.s = false;
    if (isAction(k, 'right'))    keys.d = false;
    if (isAction(k, 'reload'))   keys.r = false;
    if (isAction(k, 'sprint'))   keys.shift = false;
    if (isAction(k, 'grenade'))  keys.g = false;
    if (isAction(k, 'weapon1'))  keys['1'] = false;
    if (isAction(k, 'weapon2'))  keys['2'] = false;
    if (isAction(k, 'weapon3'))  keys['3'] = false;
    if (k === 'tab') keys.tab = false;
    if (isAction(k, 'leanLeft') || isAction(k, 'leanRight')) setLean(0);
    if (isAction(k, 'grenade')) releaseGrenade();
    if (isAction(k, 'crouch')) {
      // Hold-to-crouch: uncomment to make crouch hold-only instead of toggle
      // setCrouch(false);
    }
  });

  window.addEventListener('resize', () => {
    gameState.camera.aspect = innerWidth / innerHeight;
    gameState.camera.updateProjectionMatrix();
    gameState.renderer.setSize(innerWidth, innerHeight);
    resizeViewmodel();
  });

  window.addEventListener('wheel', (e) => {
    if (!gameState.mouseLocked) return;
    const dir = e.deltaY > 0 ? 1 : -1;
    const newSlot = (gameState.pActiveSlot + dir + gameState.pWeaponSlots.length) % gameState.pWeaponSlots.length;
    switchWeapon(newSlot);
  });

  document.addEventListener('pointerlockchange', onPointerLockChange);
  document.addEventListener('mousemove', onMouseMove);
  onPointerLockChange();

  gameState.renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
  gameState.renderer.domElement.addEventListener('mousedown', (e) => {
    if (gameState.paused || gameState.mainMenuOpen) return;
    if (!gameState.mouseLocked) {
      if (e.button === 0) requestMouseLock();
      return;
    }
    if (e.button === 2) {
      if (gameState.pWeaponId !== 'knife' && gameState.pWeaponId !== 'unarmed') beginADS(gameState.pWeaponId);
      return;
    }
    if (e.button !== 0) return;
    gameState.mouseHeld = true;
    onShoot();
  });

  gameState.renderer.domElement.addEventListener('mouseup', (e) => {
    if (e.button === 0) {
      gameState.mouseHeld = false;
      gameState.pFirstShotReady = true;
    }
    if (e.button === 2) { endADS(); return; }
  });

  dom.lockHint.addEventListener('click', () => requestMouseLock());
}
