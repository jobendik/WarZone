import * as THREE from 'three';
import * as YUKA from 'yuka';
import { gameState } from '@/core/GameState';
import { FP } from '@/config/player';
import { WEAPONS } from '@/config/weapons';
import { allowsRespawn, getFacingYawTowardsArena, getModeDefaults, getPlayerSpawn, getWorldBoundary } from '@/core/GameModes';
import { setViewmodelWeapon } from '@/rendering/WeaponViewmodel';
import { updateHUD, flashHeal } from '@/ui/HUD';
import { dom } from '@/ui/DOMElements';
import { onShoot, releaseGrenade } from '@/core/EventManager';
import type { TDMAgent } from './TDMAgent';
import type { Collider } from '@/core/GameState';
import { isPlayerInAir } from '@/br/DropPlane';
import { playerVehicle } from '@/br/Vehicles';
import { isInventoryOpen, getPlayerInventory, syncInventoryFromCombat } from '@/br/InventoryUI';
import { consumeAmmo } from '@/br/Inventory';
import { updateMovement, getCameraOffset, getCurrentPlayerHeight, requestJump, toggleCrouch, setLean, attemptSlide, movement } from '@/movement/MovementController';
import { playHeal } from '@/audio/SoundHooks';
import { getActivePerkHooks } from '@/config/Loadouts';
import { isKillcamActive, updateKillcam, isPotgActive, updatePotgReplay } from '@/ui/Killcam';

const NAV_FLOOR_SAMPLE_Y = 2.0;

/**
 * Vertical tolerance used when testing whether a 2D position sits on the
 * navmesh.  Needs to be large enough to cover ramps (the player's `pPosY`
 * lags behind the surface being stepped onto during a climb), small step-ups
 * onto crates, and elevated platforms the player is already standing on.
 * Too tight → blocked on ramps; too loose → lets the player phase through
 * walls to walkable surfaces on the other side.
 */
const NAV_COLLIDE_Y_EPSILON = 2.2;

const navPoint = new YUKA.Vector3();
const navProjectedPoint = new YUKA.Vector3();

export function getFloorY(x: number, z: number): number {
  if (gameState.navMeshManager.navMesh) {
    navPoint.set(x, NAV_FLOOR_SAMPLE_Y, z);

    const region = gameState.navMeshManager.getRegionForPoint(navPoint, Math.max(1, FP.playerRadius))
      ?? gameState.navMeshManager.getRegionForPoint(navPoint, 3);

    if (region?.getClosestPointToPoint) {
      region.getClosestPointToPoint(navPoint, navProjectedPoint);
      if (Number.isFinite(navProjectedPoint.y)) {
        return navProjectedPoint.y;
      }
    }

    return 0;
  }

  let floorY = 0;
  for (const c of gameState.colliders) {
    if (c.yTop !== undefined && gameState.pPosY >= c.yTop) {
      if (c.type === 'box') {
        if (Math.abs(x - c.x) <= c.hw && Math.abs(z - c.z) <= c.hd) floorY = Math.max(floorY, c.yTop);
      } else {
        const dx = x - c.x;
        const dz = z - c.z;
        if (dx * dx + dz * dz <= c.r * c.r) floorY = Math.max(floorY, c.yTop);
      }
    }
  }
  return floorY;
}

function collidesPlayer(x: number, z: number): boolean {
  const margin = getWorldBoundary();
  if (Math.abs(x) > margin || Math.abs(z) > margin) return true;

  if (gameState.navMeshManager.navMesh) {
    // Strict in-region test: the candidate is walkable iff it sits inside a
    // navmesh region (within NAV_COLLIDE_Y_EPSILON vertically to tolerate
    // ramps / step-ups).  No projection fallback — any distance tolerance
    // at all lets the player clip into walls, because `projectPoint` happily
    // returns a point on a region adjacent to or on the far side of a wall.
    // Doorways remain traversable because the baked navmesh has a walkable
    // region inside them.
    navPoint.set(x, gameState.pPosY, z);
    return !gameState.navMeshManager.getRegionForPoint(navPoint, NAV_COLLIDE_Y_EPSILON);
  }

  for (const c of gameState.colliders) {
    if (c.yTop !== undefined && gameState.pPosY >= c.yTop) continue;
    if (c.type === 'box') {
      if (Math.abs(x - c.x) <= c.hw && Math.abs(z - c.z) <= c.hd) return true;
    } else {
      const dx = x - c.x;
      const dz = z - c.z;
      if (dx * dx + dz * dz <= c.r * c.r) return true;
    }
  }
  return false;
}

export function keepInside(ag: TDMAgent): void {
  const boundary = getWorldBoundary();
  const margin = Math.max(0.55, ag.boundingRadius) + 0.08;
  ag.position.x = Math.max(-boundary + margin, Math.min(boundary - margin, ag.position.x));
  ag.position.z = Math.max(-boundary + margin, Math.min(boundary - margin, ag.position.z));

  for (const c of gameState.arenaColliders) {
    if (c.yTop !== undefined && ag.position.y >= c.yTop) continue;
    if (c.type === 'box') {
      const dx = ag.position.x - c.x;
      const dz = ag.position.z - c.z;
      const ox = c.hw - Math.abs(dx);
      const oz = c.hd - Math.abs(dz);
      if (ox >= 0 && oz >= 0) {
        if (ox < oz) ag.position.x = c.x + Math.sign(dx || 1) * (c.hw + 0.06);
        else ag.position.z = c.z + Math.sign(dz || 1) * (c.hd + 0.06);
      }
    } else {
      let dx = ag.position.x - c.x;
      let dz = ag.position.z - c.z;
      let distSq = dx * dx + dz * dz;
      const minR = c.r + Math.max(0.08, ag.boundingRadius * 0.15);
      if (distSq < minR * minR) {
        if (distSq < 1e-6) { dx = 1; dz = 0; distSq = 1; }
        const dist = Math.sqrt(distSq);
        ag.position.x = c.x + (dx / dist) * (minR + 0.02);
        ag.position.z = c.z + (dz / dist) * (minR + 0.02);
      }
    }
  }

  if (ag.renderComponent) {
    ag.renderComponent.position.set(ag.position.x, ag.renderComponent.position.y, ag.position.z);
  }
}

export function updatePlayer(dt: number): void {
  const { player, keys, pickups } = gameState;

  // POTG replay takes over camera
  if (isPotgActive()) {
    updatePotgReplay(dt);
    return;
  }

  if (gameState.pDead) {
    if (isKillcamActive()) {
      if (updateKillcam(dt)) return;
    }

    if (gameState.mode === 'br') {
      dom.dsp.textContent = 'Spectating killer — press ENTER for a new match';
      let target = gameState.spectatorTarget;
      if (!target || target.isDead || !target.active) {
        target = gameState.agents.find((ag) => ag !== gameState.player && !ag.isDead && ag.active && (ag as any)._brState) ?? null;
        gameState.spectatorTarget = target;
      }
      if (target) {
        const followPos = new THREE.Vector3(target.position.x, target.position.y + 2.1, target.position.z);
        const forwardDir = new THREE.Vector3(0, 0, -1);
        if (target.renderComponent) forwardDir.applyQuaternion(target.renderComponent.quaternion);
        forwardDir.y = 0;
        if (forwardDir.lengthSq() < 0.0001) forwardDir.set(0, 0, -1);
        forwardDir.normalize();
        const camPos = followPos.clone().sub(forwardDir.multiplyScalar(3.8)).add(new THREE.Vector3(0, 1.3, 0));
        gameState.camera.position.lerp(camPos, Math.min(1, dt * 4));
        gameState.camera.lookAt(followPos);
      } else {
        gameState.camera.position.set(player.position.x, FP.height + 6, player.position.z + 8);
        gameState.camera.lookAt(new THREE.Vector3(player.position.x, 0.8, player.position.z));
      }
      return;
    }

    // In elimination mode, no respawning
    if (!allowsRespawn()) {
      dom.dsp.textContent = 'Eliminated — waiting for next round…';
      gameState.camera.position.set(player.position.x, FP.height, player.position.z);
      gameState.camera.rotation.y = gameState.cameraYaw;
      gameState.camera.rotation.x = gameState.cameraPitch;
      return;
    }

    gameState.respTimer -= dt;
    dom.dsp.textContent = 'Respawning in ' + Math.max(0, gameState.respTimer).toFixed(1) + 's…';
    if (gameState.respTimer <= 0) {
      gameState.pDead = false;
      player.isDead = false;
      gameState.pHP = 100;
      player.hp = 100;
      gameState.pSpawnProtectUntil = gameState.worldElapsed + 2; // 2s spawn protection
      const startsArmed = getModeDefaults(gameState.mode).playerStartsArmed;
      gameState.pWeaponSlots = startsArmed ? ['assault_rifle', 'pistol'] : ['knife'];
      gameState.pActiveSlot = 0;
      gameState.pWeaponId = gameState.pWeaponSlots[0];
      const respawnWeapon = WEAPONS[gameState.pWeaponId];
      gameState.pAmmo = respawnWeapon.magSize;
      gameState.pMaxAmmo = respawnWeapon.magSize;
      gameState.pAmmoReserve = respawnWeapon.magSize * 3;
      gameState.pReloadDuration = respawnWeapon.reloadTime;
      gameState.pGrenades = startsArmed ? 2 : 0;
      gameState.pReloading = false;
      gameState.pPosY = 0;
      gameState.pVelY = 0;
      dom.ds.classList.remove('on');
      const sp = getPlayerSpawn();
      player.position.set(sp[0], 0, sp[2]);
      player.spawnPos.set(sp[0], 0, sp[2]);
      gameState.cameraYaw = getFacingYawTowardsArena(sp[0], sp[2]);
      gameState.cameraPitch = 0;
      setViewmodelWeapon(gameState.pWeaponId);
      updateHUD();
    }
    gameState.camera.position.set(player.position.x, FP.height, player.position.z);
    gameState.camera.rotation.y = gameState.cameraYaw;
    gameState.camera.rotation.x = gameState.cameraPitch;
    return;
  }

  // BR short-circuits: skip normal movement during air drop, inventory, or vehicle
  if (isPlayerInAir()) {
    gameState.camera.position.set(player.position.x, player.position.y + 1.6, player.position.z);
    gameState.camera.rotation.y = gameState.cameraYaw;
    gameState.camera.rotation.x = gameState.cameraPitch;
    return;
  }
  if (isInventoryOpen()) {
    gameState.camera.position.set(player.position.x, gameState.pPosY + FP.height, player.position.z);
    gameState.camera.rotation.y = gameState.cameraYaw;
    gameState.camera.rotation.x = gameState.cameraPitch;
    return;
  }
  if (playerVehicle) {
    gameState.camera.position.set(player.position.x, player.position.y + 2.0, player.position.z);
    gameState.camera.rotation.y = gameState.cameraYaw;
    gameState.camera.rotation.x = gameState.cameraPitch;
    return;
  }

  const isUnarmed = gameState.pWeaponId === 'unarmed' || gameState.pWeaponId === 'knife';

  // Reload (not when unarmed) — sprint cancels reload
  if (gameState.pReloading && !isUnarmed) {
    if (movement.isSprinting || movement.isTacSprinting) {
      gameState.pReloading = false;
      gameState.pReloadTimer = 0;
      dom.reloadBar.classList.remove('on');
      dom.reloadText.classList.remove('on');
    }
    gameState.pReloadTimer += dt;
    const pct = Math.min(1, gameState.pReloadTimer / gameState.pReloadDuration) * 100;
    dom.reloadFill.style.width = pct + '%';
    if (gameState.pReloadTimer >= gameState.pReloadDuration) {
      gameState.pReloading = false;
      if (gameState.mode === 'br') {
        const inv = getPlayerInventory();
        const activeItem = inv?.weaponSlots[inv.activeSlot];
        if (inv && activeItem && activeItem.category === 'weapon' && activeItem.weaponId) {
            const missing = Math.max(0, gameState.pMaxAmmo - gameState.pAmmo);
          const loaded = consumeAmmo(inv, activeItem.weaponId, missing);
          gameState.pAmmo += loaded;
          activeItem.currentAmmo = gameState.pAmmo;
          syncInventoryFromCombat();
        }
      } else {
        const missing = gameState.pMaxAmmo - gameState.pAmmo;
        const loaded = Math.min(missing, gameState.pAmmoReserve);
        gameState.pAmmo += loaded;
        gameState.pAmmoReserve -= loaded;
      }
      updateHUD();
      dom.reloadBar.classList.remove('on');
      dom.reloadText.classList.remove('on');
    }
  }

  // Shoot timer cooldown
  if (gameState.pShootTimer > 0) {
    gameState.pShootTimer -= dt;
  }

  // Spread decay when not firing
  if (gameState.pSpreadAccum > 0) {
    gameState.pSpreadAccum = Math.max(0, gameState.pSpreadAccum - dt * 6);
  }

  // ── Movement ──
  const { desiredVelX, desiredVelZ } = updateMovement(dt);
  if (Math.abs(desiredVelX) > 0.001 || Math.abs(desiredVelZ) > 0.001) {
    const step = dt;
    const nx = player.position.x + desiredVelX * step;
    const nz = player.position.z + desiredVelZ * step;
    const prevX = player.position.x;
    const prevZ = player.position.z;
    if (!collidesPlayer(nx, player.position.z)) player.position.x = nx;
    if (!collidesPlayer(player.position.x, nz)) player.position.z = nz;
    // Safety: if both axes moved and the combined position somehow sits inside a
    // circular obstacle (possible at high frame-times on diagonal approach), revert.
    if (player.position.x !== prevX && player.position.z !== prevZ &&
        collidesPlayer(player.position.x, player.position.z)) {
      player.position.x = prevX;
      player.position.z = prevZ;
    }
  }

  // Gravity (jump itself is handled inside updateMovement via pVelY)
  gameState.pVelY -= FP.gravity * dt;
  gameState.pPosY += gameState.pVelY * dt;
  const floorY = getFloorY(player.position.x, player.position.z);
  if (gameState.pPosY <= floorY) {
    gameState.pPosY = floorY;
    gameState.pVelY = Math.max(0, gameState.pVelY);
  }
  player.position.y = gameState.pPosY;

  // Pickup collection
  for (const pk of pickups) {
    if (!pk.active) continue;
    const dx = player.position.x - pk.x;
    const dz = player.position.z - pk.z;
    if (dx * dx + dz * dz < 2.2 * 2.2) {
      if (pk.t === 'health' && gameState.pHP < 100) {
        pk.active = false;
        pk.mesh.visible = pk.ring.visible = false;
        pk.respawnAt = gameState.worldElapsed + 15;
        gameState.pHP = Math.min(100, gameState.pHP + 35);
        player.hp = gameState.pHP;
        updateHUD();
        flashHeal();
        playHeal();
      } else if (pk.t === 'ammo' && !isUnarmed) {
        const maxReserve = gameState.pMaxAmmo * 3;
        if (gameState.pAmmoReserve < maxReserve || gameState.pAmmo < gameState.pMaxAmmo) {
          pk.active = false;
          pk.mesh.visible = pk.ring.visible = false;
          pk.respawnAt = gameState.worldElapsed + 12;
          gameState.pAmmoReserve = Math.min(maxReserve, gameState.pAmmoReserve + Math.ceil(gameState.pMaxAmmo * 0.5));
          updateHUD();
        }
      } else if (pk.t === 'grenade' && gameState.pGrenades < 4) {
        pk.active = false;
        pk.mesh.visible = pk.ring.visible = false;
        pk.respawnAt = gameState.worldElapsed + 10;
        gameState.pGrenades = Math.min(4, gameState.pGrenades + 1);
        updateHUD();
      } else if (pk.t === 'weapon' && pk.weaponId) {
        pk.active = false;
        pk.mesh.visible = pk.ring.visible = false;
        pk.respawnAt = gameState.worldElapsed + 25;
        const wepId = pk.weaponId;
        // If unarmed, replace the unarmed slot
        if (isUnarmed) {
          gameState.pWeaponSlots = [wepId];
          gameState.pActiveSlot = 0;
        } else if (!gameState.pWeaponSlots.includes(wepId)) {
          if (gameState.pWeaponSlots.length < 3) {
            gameState.pWeaponSlots.push(wepId);
          } else {
            gameState.pWeaponSlots[gameState.pActiveSlot] = wepId;
          }
        }
        gameState.pActiveSlot = gameState.pWeaponSlots.indexOf(wepId);
        gameState.pWeaponId = wepId;
        const wep = WEAPONS[wepId];
        gameState.pAmmo = wep.magSize;
        gameState.pMaxAmmo = wep.magSize;
        gameState.pAmmoReserve = wep.magSize * 3;
        gameState.pShootTimer = 0;
        gameState.pBurstCount = 0;
        gameState.pReloading = false;
        dom.reloadBar.classList.remove('on');
        dom.reloadText.classList.remove('on');
        setViewmodelWeapon(wepId, true);
        updateHUD();
        flashHeal();
        playHeal();
      }
    }
  }

  // HP regen near spawn
  let regenApplied = false;
  if (player.position.distanceTo(player.spawnPos) < 8) {
    gameState.pHP = Math.min(100, gameState.pHP + dt * 10);
    player.hp = gameState.pHP;
    regenApplied = true;
  }

  // Passive health regen after 5s without taking damage (CoD-style)
  if (!regenApplied && !gameState.pDead && gameState.pHP < 100 && gameState.pHP > 0) {
    const timeSinceDmg = gameState.worldElapsed - gameState.pLastDamageTime;
    if (timeSinceDmg > 5) {
      const regenRate = (8 + Math.min(12, (timeSinceDmg - 5) * 4)) * (getActivePerkHooks().healthRegenMul ?? 1);
      gameState.pHP = Math.min(100, gameState.pHP + dt * regenRate);
      player.hp = gameState.pHP;
      regenApplied = true;
    }
  }

  if (regenApplied) updateHUD();

  // Auto-fire: keep shooting while mouse held (only if armed)
  if (gameState.mouseHeld && gameState.mouseLocked && !isUnarmed) {
    onShoot();
  }

  // Grenade cooldown
  if (gameState.pGrenadeCooldown > 0) {
    gameState.pGrenadeCooldown -= dt;
  }

  // Grenade cook timer
  if (gameState.pCookingGrenade) {
    gameState.pCookTimer += dt;
    if (gameState.pCookTimer >= 2.8) {
      releaseGrenade();
    }
  }

  // Camera
  const ofs = getCameraOffset();
  const camHeight = getCurrentPlayerHeight();
  gameState.camera.position.set(
    player.position.x + Math.cos(gameState.cameraYaw) * ofs.x,
    gameState.pPosY + camHeight + ofs.y,
    player.position.z - Math.sin(gameState.cameraYaw) * ofs.x,
  );
  gameState.camera.rotation.y = gameState.cameraYaw;
  gameState.camera.rotation.x = gameState.cameraPitch;
  gameState.camera.rotation.z = ofs.tilt;
}
